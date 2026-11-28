// エンドレス巡回ナビの中核
// ・確定区間（commit）より手前のルートは絶対に変えない
// ・新ルートは確定区間の終点から、進行方向を保ったまま接続する
// ・案内済みの右左折はロック
// ・需要の小さな変化では切り替えない（ヒステリシス＋最小間隔）
// ・候補のエリアが複数あるときは、近くの需要エリアをつないで「通り抜ける」ルートにする（巡回ツアー）
// ・ゴールは作らない：ルートの先が短くなる前に、今のルートの終わりから次のポイントを計算して後ろにつなぎ続ける
import { haversine, bearing, angleDiff, cumulative, snapToRoute, pointAt, sliceRoute, sampleLine } from './geo.js?v=42';
import { nearestUtility, expectedRevenueRate, CIRCUITY, tourRate, travelMinutes } from './demand.js?v=42';

export const DEFAULTS = {
  commitSec: 30, // 確定区間（秒）
  commitMinM: 300, // 確定区間の最小距離
  minFirstTurnSec: 10, // 接続直後の最初の右左折までの最小余裕
  minFirstTurnM: 150,
  lookAheadM: 2500, // ルートの先がこれ（または lookAheadSec 秒分）より短くなったら、終わりに次の区間をつなぐ
  lookAheadSec: 180,
  replanMs: 180000, // 需要変化による切替の最小間隔
  switchGain: 1.3, // 切替に必要な需要の改善倍率
  offRouteM: 40, // ルートからこれ以上離れたら「外れた」
  offRouteTurnM: 20, // これ以上離れて、進む向きがルートと50度以上違えば「外れた」（別の道へ曲がった）
  radiusM: 6000,
  tourMax: 3, // 1回のルートで通るエリアの数（1なら1か所ずつ）
  tourHopM: 2500, // ツアーで次のエリアまでの直線距離の上限
  tourMaxM: 8000, // ツアー全体の直線距離の上限
  tourMinRatio: 0.3, // 2か所目以降は、1か所目の価値のこの割合以上のエリアだけ
  passM: 250, // エリアの中心からこの距離以内を通ったら「通過」
  pickMode: 'demand', // 行き先の選び方：'demand'＝需要の高さ優先（空車の時間あたりの期待収入。初期設定）、'nearest'＝今いる所から近い需要エリア順
  revisitMin: 60, // 回ったエリア（とその近く）は、この時間は行き先にしない
  trackMin: 45, // 走った道を覚えておく時間（同じ道を何度も通らないように）
  maxOverlap: 0.4, // 新しい区間のうち、最近走った道と重なる割合がこれを超えるルートは使わない（他の案があれば）
  poorAccuracyM: 60, // これより精度の悪いGPS（ビル街・トンネル）は、ルートから外れた判定に使わない
  rerouteCooldownMs: 12000, // 計算し直す間隔の下限（GPSの乱れで繰り返さない）
  offRouteCount: 2, // 続けてこの回数「外れた」ら計算し直す
};

// ルート上の向き：前後数十メートルの2点から測る（細かい折れ線の向きの揺れで印や地図がぶれないように）
export function routeBearing(route, along) {
  const a = pointAt(route, Math.max(0, along - 8)).point, b = pointAt(route, Math.min(route.length, along + 15)).point;
  return haversine(a, b) > 1 ? bearing(a, b) : pointAt(route, along).bearing;
}

const REFILL_MIN = 10; // 通った道に、新しく手を挙げる人がまた現れるまでの時間の目安（分）。仮の値
const angleDiffDeg = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function voiceDistance(m) {
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toFixed(1).replace('.0', '')}キロ`;
  if (m >= 100) return `${Math.round(m / 50) * 50}メートル`;
  return `${Math.max(10, Math.round(m / 10) * 10)}メートル`;
}

export class EndlessNavigator {
  constructor({ router, demand, settings = {}, emit = () => {}, now = () => Date.now() }) {
    this.router = router;
    this.demand = demand;
    this.s = { ...DEFAULTS, ...settings };
    this.emit = emit;
    this.now = now;
    this.reset();
  }

  reset() {
    this.gen = (this.gen || 0) + 1; // 計算中のルートを古いものとして捨てる目印（休止・再開・開始し直し）
    this.planning = false;
    this.route = null;
    this.along = 0;
    this.pos = null;
    this.speed = 0;
    this.heading = null;
    this.target = null; // 次に通るエリア
    this.tour = []; // 今のルートで通るエリア [{ area, at, passed }]
    this.planning = false;
    this.lastPlanAt = 0;
    this.nextTryAt = 0;
    this.failCount = 0; // ルートの計算に続けて失敗した回数（待つ時間を延ばす）
    this.lastRerouteAt = 0;
    this.offCount = 0;
    this.onRoute = false; // 今の位置がルートの上か（現在地の印をルートの線に合わせて出す）
    this.track = [];
    this.badTargets = new Map();
    this.serviceCenter = null;
  }

  // ===== 位置更新 =====
  update(fix) {
    const t = fix.t || this.now();
    const prev = this.track[this.track.length - 1];
    if (prev && haversine(prev.p, fix.point) < 3 && fix.speed == null) return;
    // 速度・方位の推定
    if (fix.speed != null && fix.speed >= 0) this.speed = fix.speed;
    else if (prev) this.speed = haversine(prev.p, fix.point) / Math.max(0.5, (t - prev.t) / 1000);
    if (fix.heading != null && !Number.isNaN(fix.heading) && this.speed > 1.5) this.heading = fix.heading;
    else if (prev && haversine(prev.p, fix.point) > 5) this.heading = bearing(prev.p, fix.point);
    this.pos = fix.point;
    if (!this.serviceCenter) this.serviceCenter = fix.point;
    this.track.push({ p: fix.point, t });
    while (this.track.length && t - this.track[0].t > this.s.trackMin * 60e3) this.track.shift();
    this.markDriveBy(fix.point, t);

    if (this.route) {
      const snap = snapToRoute(this.route, fix.point, this.along);
      const acc = fix.accuracy == null ? 10 : fix.accuracy;
      // 外れた：ルートから離れた、または別の道へ曲がった（少し離れて、進む向きがルートと大きく違う）
      const routeDir = pointAt(this.route, snap.along).bearing;
      const turnedAway = this.speed > 3 && this.heading != null && snap.dist > Math.max(this.s.offRouteTurnM, acc) && angleDiff(this.heading, routeDir) > 50;
      if (snap.dist > Math.max(this.s.offRouteM, acc * 1.2) || turnedAway) {
        // 精度の悪い位置（ビル街・トンネル）では「外れた」と数えない（位置が跳んでも計算し直さない）
        if (acc <= this.s.poorAccuracyM) this.offCount++;
        this.onRoute = false;
      } else { this.offCount = 0; this.onRoute = true; this.along = Math.max(this.along - 20, snap.along); }
      this.snapDist = snap.dist;
      this.checkPassed();
      // 外れたら、元のルートへ戻す案内はせず、今いる所・進んでいる向きから行き先を選び直して計算し直す
      if (this.offCount >= this.s.offRouteCount && !this.planning && t - this.lastRerouteAt > this.s.rerouteCooldownMs) {
        this.offCount = 0;
        this.lastRerouteAt = t;
        this.emit('voice', 'ルートを外れました。新しいルートを計算します');
        this.plan('reroute');
        return;
      }
      if (this.onRoute) this.announce(); // 外れている間は、元のルートの右左折を読み上げない
    }
    this.tick();
  }

  // 現在地の印を出す位置：ルートの上を走っている間は、GPSの位置ではなくルート上の位置（along）に合わせる
  // （GPSの誤差で印が道の横にずれたり、ルートの線から離れたりしないように）。向きもルートの向き
  // 外れている時・ルートが無い時は GPS の位置と進行方位
  displayPos() {
    if (this.route && this.onRoute) {
      const at = pointAt(this.route, this.along);
      return { point: at.point, bearing: routeBearing(this.route, this.along), along: this.along, route: this.route };
    }
    return this.pos ? { point: this.pos, bearing: this.heading ?? 0, along: null, route: null } : null;
  }

  // ツアーに入っていなくても、近くを通った需要エリアは「回った」扱い（すぐ戻ってこないように）
  markDriveBy(p, t) {
    for (const a of this.demand.areas.values()) {
      if (haversine(p, a.center) > this.s.passM) continue;
      const v = this.demand.visited.get(a.key);
      if (!v || t - v.t > 5 * 60e3) this.demand.markVisited(a.key, t, a.center);
    }
  }

  // ===== ツアーの通過 =====
  tourRemaining() { return this.tour.filter((x) => !x.passed).map((x) => x.area); }

  checkPassed() {
    let changed = false;
    for (const x of this.tour) {
      if (x.passed || x.at == null || this.along < x.at - 30) continue;
      x.passed = true; changed = true;
      this.demand.markVisited(x.area.key, this.now(), x.area.center);
      this.emit('pass', x.area);
    }
    if (changed) this.target = this.tourRemaining()[0] || null;
  }

  // ===== 音声案内 =====
  nextActions() {
    if (!this.route) return [];
    return this.route.maneuvers.filter((m) => m.action && m.at > this.along + 5);
  }

  announce() {
    const [next, then] = this.nextActions();
    if (!next) return;
    const dist = next.at - this.along;
    const v = Math.max(this.speed, 5);
    const farTh = clamp(v * 25, 250, 800);
    const nearTh = clamp(v * 7, 60, 150);
    const street = next.street ? `、${next.street}方面` : '';
    if (!next.announced && dist <= farTh && dist > nearTh + 40) {
      next.announced = 'far';
      this.emit('voice', `およそ${voiceDistance(dist)}先、${next.ja}です${street}`);
    } else if (next.announced !== 'near' && dist <= nearTh) {
      next.announced = 'near';
      let msg = `まもなく${next.ja}です${street}`;
      if (then && then.at - next.at < 120) {
        msg += `。その先すぐ${then.ja}です`;
        if (!then.announced) then.announced = 'far';
      }
      this.emit('voice', msg);
    }
  }

  // ===== 確定区間 =====
  commitAlong() {
    let c = this.along + Math.max(this.s.commitMinM, this.speed * this.s.commitSec);
    for (const m of this.route.maneuvers) {
      if (m.announced && m.at >= this.along - 5) c = Math.max(c, m.at + 40);
    }
    return Math.min(c, this.route.length - 1);
  }

  // ===== 計画 =====
  tick() {
    if (this.planning || this.now() < this.nextTryAt || !this.pos) return;
    if (!this.route) return void this.plan('initial');
    const remaining = this.route.length - this.along;
    if (remaining < Math.max(this.s.lookAheadM, this.speed * this.s.lookAheadSec)) return void this.plan('extend');
    if (this.now() - this.lastPlanAt > this.s.replanMs && this.target) {
      const c = this.commitAlong();
      const start = pointAt(this.route, c);
      const ranked = this.rankFrom(start.point, start.bearing);
      const remain = this.tourRemaining();
      const inTour = new Set(remain.map((a) => a.key));
      const best = ranked.find((x) => !inTour.has(x.area.key));
      if (best) {
        const opts = this.rankOpts();
        const cur = Math.max(0, ...remain.map((a) => this.demand.utilityOf(a.key, start.point, start.bearing, opts)));
        if (best.utility >= cur * this.s.switchGain) return void this.plan('switch', [best.area]);
      }
      this.lastPlanAt = this.now(); // 切替不要 → 次回チェックまで待つ
    }
  }

  rankOpts() {
    const now = this.now();
    const exclude = new Set();
    for (const [k, until] of this.badTargets) if (until > now) exclude.add(k);
    return { center: this.serviceCenter, radiusM: this.s.radiusM, exclude, now, revisitMin: this.s.revisitMin, pick: this.s.pickMode };
  }

  // まだ回っていないエリア → 営業エリアの外も → それでも無ければ、一番前に回ったエリア（点数を下げて）
  rankFrom(point, heading) {
    const o = this.rankOpts();
    let r = this.demand.rank(point, heading, o);
    // 最短距離モードで需要の大きいエリアを回り切った時は、需要の小さいまだ回っていないエリアへ（同じ所に戻るより先に）
    if (!r.length && o.pick === 'nearest') r = this.demand.rank(point, heading, { ...o, minShare: 0.1 });
    if (!r.length && o.pick === 'nearest') r = this.demand.rank(point, heading, { ...o, minShare: 0 });
    if (!r.length) r = this.demand.rank(point, heading, { ...o, center: null, minDistM: 300 });
    if (!r.length) r = this.demand.rank(point, heading, { ...o, strict: false, minDistM: 300 });
    return r;
  }

  // 新しい区間が最近走った道と重なる割合
  overlap(route, from = 0) {
    const grid = this.trackGrid();
    const pts = sampleLine(sliceRoute(route, from), 50);
    if (pts.length < 4) return 0;
    let hit = 0;
    for (const p of pts) if (grid.has(gridKey(p))) hit++;
    return hit / pts.length;
  }

  // これから通る予定のエリア（とその500m以内）は、次の区間の行き先にしない
  nearPlanned(area, planned) { return planned.some((p) => p.key === area.key || haversine(p.center, area.center) < 500); }

  // 1か所目 first から、近くの需要エリアを順につないだツアーを作る。
  // 複数の候補地を通るのが基本：通常の条件で1か所しか選べない時は、条件をゆるめて（1つ先まで4km・価値1割以上）もう一度選ぶ
  buildTour(start, first, exclude = new Set(), planned = []) {
    const max = Math.max(1, Math.round(this.s.tourMax || 1));
    if (max === 1) return [first];
    const t = this.buildTourWith(start, first, exclude, planned, this.s.tourHopM, this.s.tourMinRatio, this.s.tourMaxM);
    return t.length > 1 ? t : this.buildTourWith(start, first, exclude, planned, Math.max(this.s.tourHopM, 4000), 0.1, Math.max(this.s.tourMaxM, 10000), 0.1);
  }

  // minShare：最短距離モードで行き先にする需要の下限（一番高いエリアに対する割合）
  buildTourWith(start, first, exclude, planned, hopM, minRatio, maxM, minShare = 0.25) {
    const max = Math.max(1, Math.round(this.s.tourMax || 1));
    const tour = [first];
    const base = this.rankOpts();
    const used = new Set([...base.exclude, ...exclude, first.key]);
    const plan = planned.concat(first);
    const firstU = this.demand.utilityOf(first.key, start.point, start.bearing, base) || 1e-9;
    let prev = start.point, cur = first.center, total = haversine(start.point, first.center);
    while (tour.length < max) {
      const r = this.demand.rank(cur, bearing(prev, cur), { ...base, exclude: used, minDistM: 400, minShare });
      const c = r.find((x) => x.dist <= hopM && !this.nearPlanned(x.area, plan));
      if (!c || c.utility < firstU * minRatio || total + c.dist > maxM) break;
      tour.push(c.area);
      plan.push(c.area);
      used.add(c.area.key);
      total += c.dist;
      prev = cur; cur = c.area.center;
    }
    return tour;
  }

  // 需要の高さ優先：通るエリアの組み合わせと順番を、時間あたりの期待収入（再生報酬定理。demand.js の tourRate）が
  // 一番高いものに決める。上位 M か所から、長さ 1〜tourMax のすべての並べ方を調べる（M=7・4か所でも約1100通り）
  // 制約：1つ先まで hopM 以内・全体で maxM 以内・計画済みのエリアの近くは通らない。曲がる角度が大きい区間は遠い扱い（Uターン）
  // 1か所目までの移動は、道のりを測ってあれば道のりで（roadRerank の road）
  // 複数の候補地を通るのが基本（設定の「通るエリアの数」が2以上なら、2か所以上のツアーの中で一番良いもの。
  // 通常の制約で2か所目が無い時は、制約をゆるめて探す）
  optimizeTour(start, cands, planned, max = Math.max(1, Math.round(this.s.tourMax || 1)), M = 7, relax = false) {
    const refDens = this.demand.refDens();
    const C = cands.slice(0, M).map((x) => ({
      x, area: x.area, fare: x.area.fare || 1,
      search: Math.min(600, this.demand.searchMin * (refDens / Math.max(1e-9, x.area.dens || x.area.score * x.area.score))),
      firstLeg: x.road != null ? x.road / ((20 * 1000) / 60) : travelMinutes(x.effM != null ? x.effM : x.dist),
    }));
    const hopM = relax ? Math.max(this.s.tourHopM, 4000) : this.s.tourHopM, maxM = relax ? Math.max(this.s.tourMaxM, 10000) : this.s.tourMaxM;
    let best = null, bestMulti = null;
    const seq = [];
    const rec = (prevPt, prevBrg, legs, totalM) => {
      if (seq.length) {
        const stops = seq.map((c, i) => ({ legMin: legs[i], searchMin: c.search, fare: c.fare }));
        const v = tourRate(stops);
        const cand = { v, tour: seq.map((c) => c.area), stops };
        if (!best || v > best.v + 1e-12) best = cand;
        if (seq.length > 1 && (!bestMulti || v > bestMulti.v + 1e-12)) bestMulti = cand;
      }
      if (seq.length >= max) return;
      for (const c of C) {
        if (seq.includes(c) || this.nearPlanned(c.area, planned) || seq.some((o) => haversine(o.area.center, c.area.center) < 500)) continue;
        let leg, d;
        if (!seq.length) { leg = c.firstLeg; d = c.x.dist; }
        else {
          d = haversine(prevPt, c.area.center);
          if (d > hopM || totalM + d > maxM) continue;
          const turn = prevBrg != null ? angleDiffDeg(prevBrg, bearing(prevPt, c.area.center)) : 0;
          leg = travelMinutes(d * (1 + 0.6 * (turn / 180)));
        }
        seq.push(c); legs.push(leg);
        rec(c.area.center, bearing(prevPt, c.area.center), legs, totalM + d);
        seq.pop(); legs.pop();
      }
    };
    rec(start.point, start.bearing, [], 0);
    if (max > 1 && !bestMulti && !relax && C.length > 1) return this.optimizeTour(start, cands, planned, max, M, true) || best;
    return max > 1 && bestMulti ? { ...bestMulti, single: best } : best;
  }

  // 直線で選んだ上位の候補を、道のりの距離（ルートサーバーの距離の行列）で並べ直す。
  // 川・線路・一方通行で直線より遠回りになるエリアを後ろへ。使えない時は直線のまま
  // 需要の高さ優先：行き先までの時間を、直線×迂回係数ではなく実際の道のりで見て、空車の時間あたりの期待収入を計算し直す
  async roadRerank(start, ranked) {
    if (!this.router.matrix || ranked.length < 2) return ranked;
    const top = ranked.slice(0, 6);
    let dist;
    try { dist = await this.router.matrix({ point: start.point, heading: start.bearing }, top.map((x) => x.area.center)); }
    catch { return ranked; }
    let maxScore = 0;
    for (const a of this.demand.areas.values()) maxScore = Math.max(maxScore, a.score);
    const refDens = this.demand.refDens();
    const util = (x, road) => (this.s.pickMode === 'nearest'
      ? nearestUtility(road, x.area.score / (maxScore || 1))
      : expectedRevenueRate(x.area, road / CIRCUITY, this.demand.searchMin, refDens)); // 道のりなので迂回係数は掛けない
    const re = top.map((x, i) => (dist[i] == null ? { ...x, utility: x.utility * 0.5 } : { ...x, road: dist[i], utility: util(x, dist[i]) }));
    re.sort((a, b) => b.utility - a.utility);
    return re.concat(ranked.slice(6));
  }

  // 試す順のルート案（ツアー → 1か所だけ → 次点の1か所）
  async candidatePlans(mode, start, preferred) {
    const old = new Set(this.tour.map((x) => x.area.key));
    // 先へつなぐ時は、今のルートでこれから通るエリアの近くには行かない
    const planned = mode === 'extend' ? this.tourRemaining() : [];
    let firsts = preferred;
    if (!firsts) {
      const exclude = mode === 'extend' ? old : new Set();
      let ranked = this.rankFrom(start.point, start.bearing).filter((x) => !exclude.has(x.area.key));
      // 候補地をすべて今のルートで回る時（エリアが少ない時）も止まらないよう、ルートの終わりのエリア以外から選ぶ
      if (!ranked.length && mode === 'extend') {
        const lastKey = this.tour.length ? this.tour[this.tour.length - 1].area.key : null;
        ranked = this.demand.rank(start.point, start.bearing, { ...this.rankOpts(), strict: false, minDistM: 300 }).filter((x) => x.area.key !== lastKey);
      }
      let fresh = ranked.filter((x) => !this.nearPlanned(x.area, planned));
      if (!fresh.length) fresh = ranked; // 他に無ければ止まらないことを優先
      fresh = await this.roadRerank(start, fresh);
      this._fresh = fresh;
      firsts = fresh.slice(0, 2).map((x) => x.area);
    }
    if (!firsts.length) return [];
    const plans = [];
    // 需要の高さ優先：組み合わせと順番を期待収入で最適化（使えない時は、これまでどおり1か所目から順に足す）
    if (!preferred && this.s.pickMode !== 'nearest' && this._fresh && this._fresh.length) {
      const opt = this.optimizeTour(start, this._fresh, planned);
      this._fresh = null;
      if (opt) {
        this.lastOpt = opt;
        if (opt.tour.length > 1) plans.push(opt.tour);
        const singles = [opt.tour[0], ...firsts.filter((a) => a.key !== opt.tour[0].key)].slice(0, 2);
        for (const a of singles) plans.push([a]);
        return plans;
      }
    }
    // 外れた時も、元の行き先にこだわらず今いる所から選び直す（元の行き先が今も一番良ければ、それが選ばれる）
    const tour = this.buildTour(start, firsts[0], mode === 'extend' ? old : new Set(), planned);
    if (tour.length > 1) plans.push(tour);
    for (const a of firsts.slice(0, 2)) plans.push([a]);
    return plans;
  }

  // 休止：案内を止め、計算中のルートは届いても使わない
  pause() {
    this.gen = (this.gen || 0) + 1;
    this.planning = false;
    this.route = null; this.target = null; this.tour = []; this.onRoute = false;
  }

  async plan(mode, preferred = null) {
    if (this.planning) return;
    // 今のルートの先へつなぐ・切り替える計算は、ルートが無ければしない
    if (mode !== 'initial' && mode !== 'reroute' && !this.route) mode = 'initial';
    if ((mode === 'initial' || mode === 'reroute') && !this.pos) return;
    const gen = this.gen;
    this.planning = true;
    this.planMode = mode;
    try {
      let start, commit = null;
      // 先へつなぐ時は、今のルートの終わりから計算する（走っている先は何も変えない。右左折まで十分な距離もある）
      const relaxed = mode === 'initial' || mode === 'reroute' || mode === 'extend';
      if (mode === 'extend') {
        commit = this.route.length;
        start = pointAt(this.route, commit);
      } else if (relaxed) {
        start = { point: this.pos, bearing: this.heading };
      } else {
        commit = this.commitAlong();
        start = pointAt(this.route, commit);
      }
      const plans = await this.candidatePlans(mode, start, preferred);
      if (gen !== this.gen) return; // 行き先を選んでいる間に休止・再開した
      if (!plans.length) {
        this.emit('status', '周辺に需要エリアがありません。設定で需要スポットを取得してください');
        this.nextTryAt = this.now() + 15000;
        return;
      }
      let lastErr = null;
      for (const tour of plans.slice(0, 3)) {
        const dest = tour[tour.length - 1];
        const via = tour.slice(0, -1).map((a) => a.center);
        let routes;
        try {
          routes = await this.router.route({ point: start.point, heading: start.bearing }, dest.center, via.length ? { via } : undefined);
        } catch (e) {
          lastErr = e;
          // 通信の問題の時は行き先のせいではないので、行き先を外さない
          if (!via.length && !e.offline) this.badTargets.set(dest.key, this.now() + 10 * 60e3);
          if (e.offline) break; // つながらない時は他の案も試さない（無駄に待たない）
          continue;
        }
        // 応答待ちの間に休止・再開・開始し直しがあったら、このルートは使わない
        if (gen !== this.gen || (commit != null && !this.route)) return;
        // 応答待ちの間に確定区間の終点（先へつなぐ時はルートの終わり）を通り過ぎていたら破棄
        if (commit != null && this.along > commit - 30) break;
        const remaining = this.route ? this.route.length - this.along : Infinity;
        const best = this.pickBest(routes, relaxed || remaining < 250);
        if (!best) continue;
        // 走ったばかりの道を何度も通るルートは、他の案があれば使わない（同じ所をぐるぐる回らない）
        if (tour !== plans[Math.min(plans.length, 3) - 1] && this.overlap(best) > this.s.maxOverlap) continue;
        if (this.failCount >= 2) this.emit('status', 'ルートの計算が戻りました');
        this.failCount = 0;
        this.apply(mode, tour, best, commit);
        return;
      }
      // 失敗が続く時は待つ時間を延ばし（5秒→10秒→20秒→…最大60秒）、お知らせは最初の1回と、その後はたまに
      this.failCount++;
      this.nextTryAt = this.now() + Math.min(60000, 5000 * 2 ** (this.failCount - 1));
      if (lastErr && (this.failCount === 1 || this.failCount % 5 === 0)) this.emit('status', `${lastErr.message}。少し待って再試行します`);
    } catch (e) {
      // 思わぬ不具合でも案内は止めない（少し待ってからもう一度計算する）
      if (gen === this.gen) { this.nextTryAt = this.now() + 10000; this.emit('status', 'ルートの計算に失敗しました。少し待って再試行します'); }
      if (typeof console !== 'undefined') console.warn('plan', e);
    } finally {
      if (gen === this.gen) this.planning = false;
    }
  }

  // 慌ただしい操作にならない候補を選ぶ
  // ===== ルート案の選び方 =====
  // ルートサーバーが出した案（最大3つ）から、空車の時間あたりの期待収入が一番高いものを選ぶ（再生報酬定理。demand.js の tourRate と同じ考え方）
  //   ・走っている途中でも乗車は起きる：ルートに沿って50mごとに、その地点の乗車の起きやすさ λ（需要マップ）× 通る時間 を足し、
  //     途中で乗せる確率 1 − e^(−Σλt)（ポアソン過程）を出す。需要の多い道を通る案ほど高い（Ge ほか 2010、Yuan ほか 2011、Qu ほか 2014）
  //   ・少し前に通った道は、そこで待っていた人はもういないので、乗車の起きやすさを 1 − e^(−経過分/10) に下げる
  //     （新しく手を挙げる人が少しずつ現れる。これから走る予定の道も同じく0とみなす）
  //   ・運転のしやすさ・安全：曲がる回数（1回15秒）、右折（さらに20秒。交差点の事故は右折時に多い）、Uターン（400秒）、
  //     100m以内の連続した右左折（60秒。曲がり損ねやすい）を、時間に足して比べる
  pickBest(routes, relaxed) {
    const v = Math.max(this.speed, 5);
    const minGap = Math.max(this.s.minFirstTurnM, v * this.s.minFirstTurnSec);
    const refDens = this.demand.refDens();
    const seen = this.trackTimes();
    let best = null;
    for (const r of routes) {
      const acts = r.maneuvers.filter((m) => m.action);
      if (!relaxed && acts.length && acts[0].at < minGap) continue;
      const value = this.routeValue(r, refDens, seen);
      if (!best || value.rate > best.rate) best = { route: r, ...value };
    }
    if (best) this.lastRouteValue = best;
    return best && best.route;
  }

  // 運転のしやすさ・安全の手間（秒）
  routeEffortSec(r) {
    const acts = r.maneuvers.filter((m) => m.action);
    let sec = acts.length * 15 + acts.filter((m) => m.right).length * 20 + acts.filter((m) => m.uturn).length * 400;
    for (let i = 1; i < acts.length; i++) if (acts[i].at - acts[i - 1].at < 100) sec += 60;
    return sec;
  }

  // 走った道（約40m四方）ごとの、最後に通った時刻。これから走る予定の道（先へつなぐ時）は「今」とみなす
  trackTimes() {
    const m = new Map();
    for (const { p, t } of this.track) m.set(gridKey(p), t);
    if (this.route && this.planMode === 'extend') { const now = this.now(); for (const p of sampleLine(sliceRoute(this.route, this.along, this.route.length - 50), 25)) m.set(gridKey(p), now); }
    return m;
  }

  // ルート案の期待収入：{ rate（運賃の比/分）, pEnRoute（途中で乗せる確率）, minutes（走る時間）, effortSec, overlap }
  routeValue(r, refDens = this.demand.refDens(), seen = this.trackTimes()) {
    const now = this.now();
    const total = Math.max(1, r.length), minutes = (r.time || r.length / ((20 * 1000) / 60) * 60) / 60;
    const pts = sampleLine(r.coords, 50);
    let S = 1, ER = 0, ET = 0, hit = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = haversine(pts[i - 1], pts[i]), dt = (minutes * seg) / total;
      const k = gridKey(pts[i]), last = seen.get(k);
      if (last != null) hit++;
      const avail = last == null ? 1 : 1 - Math.exp(-Math.max(0, now - last) / 60e3 / REFILL_MIN);
      const lam = this.demand.rateAt(pts[i], refDens) * avail;
      const p = 1 - Math.exp(-lam * dt);
      ER += S * p * this.demand.fareAt(pts[i]);
      ET += S * dt;
      S *= 1 - p;
    }
    // 行き先に着いても乗せていなければ、そこで乗せるまで回る（平均 1/λ）
    const dest = r.coords[r.coords.length - 1];
    ER += S * this.demand.fareAt(dest);
    ET += S * Math.min(600, 1 / Math.max(1e-6, this.demand.rateAt(dest, refDens)));
    const effortSec = this.routeEffortSec(r);
    ET += effortSec / 60;
    return { rate: ER / ET, pEnRoute: 1 - S, minutes, effortSec, overlap: hit / Math.max(1, pts.length - 1) };
  }


  // 最近走った道と、これから走る予定の道（同じ交差点・同じ道を2回通るルートを避ける）
  trackGrid() {
    const s = new Set();
    for (const { p } of this.track) s.add(gridKey(p));
    // 先へつなぐ時だけ（切替・リルートでは今のルートの先は置き換わるので含めない）。つなぎ目の50mは除く
    if (this.route && this.planMode === 'extend') for (const p of sampleLine(sliceRoute(this.route, this.along, this.route.length - 50), 25)) s.add(gridKey(p));
    return s;
  }

  apply(mode, tour, newRoute, commit) {
    if (!Array.isArray(tour)) tour = [tour];
    let newFrom; // 新しい区間が始まる位置（つないだ後のルート上の距離）
    let kept = []; // まだ通っていない、残すルート上のエリア
    if (commit == null) {
      this.route = newRoute;
      this.along = 0;
      this.onRoute = false;
      if (this.pos) { const sn = snapToRoute(newRoute, this.pos); this.along = sn.along; this.onRoute = sn.dist <= this.s.offRouteM; }
      newFrom = this.along;
    } else {
      const keepFrom = Math.max(0, this.along - 300);
      kept = this.tour.filter((x) => !x.passed && x.at != null && x.at <= commit).map((x) => ({ ...x, at: x.at - keepFrom }));
      this.route = stitch(this.route, keepFrom, commit, newRoute);
      this.along -= keepFrom;
      newFrom = commit - keepFrom;
    }
    // 各エリアをルート上で一番近づく位置に対応させる（そこを過ぎたら「通過」）
    let hint = newFrom;
    const added = tour.map((area) => {
      const sn = snapToRoute(this.route, area.center, hint);
      if (sn.dist <= this.s.passM) hint = sn.along;
      return { area, at: Math.max(newFrom, sn.along), passed: false, dist: sn.dist };
    });
    this.tour = kept.concat(added);
    this.target = this.tourRemaining()[0] || tour[0];
    this.lastPlanAt = this.now();
    this.emit('route', { mode, target: this.target, tour: tour.slice(), upcoming: this.tourRemaining(), route: this.route });
  }

  // ===== UI用 =====
  view() {
    if (!this.route) return null;
    const [next, then] = this.nextActions();
    const remaining = this.route.length - this.along;
    return {
      next,
      nextDist: next ? next.at - this.along : remaining,
      then: then && next && then.at - next.at < 300 ? then : null,
      target: this.target,
      tour: this.tourRemaining(),
      nextPointDist: (() => { const x = this.tour.find((y) => !y.passed); return x ? Math.max(0, x.at - this.along) : null; })(),
      remaining,
      eta: remaining / Math.max(this.speed, 6),
      commitAlong: this.commitAlong(),
    };
  }
}

const gridKey = (p) => `${Math.round(p[1] / 0.0003)}:${Math.round(p[0] / 0.00037)}`;

// 既存ルートの [keepFrom, commit] に新ルートを接続
export function stitch(route, keepFrom, commit, next) {
  const prefix = sliceRoute(route, keepFrom, commit);
  const coords = prefix.concat(next.coords);
  const cum = cumulative(coords);
  const base = cum[prefix.length];
  const maneuvers = [];
  for (const m of route.maneuvers) if (m.at >= keepFrom && m.at < commit) maneuvers.push({ ...m, at: m.at - keepFrom });
  for (const m of next.maneuvers) maneuvers.push({ ...m, at: m.at + base });
  return { coords, cum, length: cum[cum.length - 1], time: next.time, maneuvers };
}
