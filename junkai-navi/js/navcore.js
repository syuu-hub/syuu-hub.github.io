// エンドレス巡回ナビの中核
// ・確定区間（commit）より手前のルートは絶対に変えない
// ・新ルートは確定区間の終点から、進行方向を保ったまま接続する
// ・案内済みの右左折はロック
// ・需要の小さな変化では切り替えない（ヒステリシス＋最小間隔）
// ・候補のエリアが複数あるときは、近くの需要エリアをつないで「通り抜ける」ルートにする（巡回ツアー）
// ・ゴールは作らない：ルートの先が短くなる前に、今のルートの終わりから次のポイントを計算して後ろにつなぎ続ける
import { haversine, bearing, cumulative, snapToRoute, pointAt, sliceRoute, sampleLine } from './geo.js?v=18';
import { nearestUtility } from './demand.js?v=18';

export const DEFAULTS = {
  commitSec: 30, // 確定区間（秒）
  commitMinM: 300, // 確定区間の最小距離
  minFirstTurnSec: 10, // 接続直後の最初の右左折までの最小余裕
  minFirstTurnM: 150,
  lookAheadM: 2500, // ルートの先がこれ（または lookAheadSec 秒分）より短くなったら、終わりに次の区間をつなぐ
  lookAheadSec: 180,
  replanMs: 180000, // 需要変化による切替の最小間隔
  switchGain: 1.3, // 切替に必要な需要の改善倍率
  offRouteM: 45,
  radiusM: 6000,
  tourMax: 3, // 1回のルートで通るエリアの数（1なら1か所ずつ）
  tourHopM: 2500, // ツアーで次のエリアまでの直線距離の上限
  tourMaxM: 8000, // ツアー全体の直線距離の上限
  tourMinRatio: 0.3, // 2か所目以降は、1か所目の価値のこの割合以上のエリアだけ
  passM: 250, // エリアの中心からこの距離以内を通ったら「通過」
  pickMode: 'nearest', // 行き先の選び方：'nearest'＝今いる所から近い需要エリア順、'demand'＝需要の高さ優先
  revisitMin: 60, // 回ったエリア（とその近く）は、この時間は行き先にしない
  trackMin: 45, // 走った道を覚えておく時間（同じ道を何度も通らないように）
  maxOverlap: 0.4, // 新しい区間のうち、最近走った道と重なる割合がこれを超えるルートは使わない（他の案があれば）
};

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
    this.offCount = 0;
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
      if (snap.dist > Math.max(this.s.offRouteM, acc * 1.2)) this.offCount++;
      else { this.offCount = 0; this.along = Math.max(this.along - 20, snap.along); }
      this.snapDist = snap.dist;
      this.checkPassed();
      if (this.offCount >= 3 && !this.planning) {
        this.offCount = 0;
        this.emit('voice', 'ルートを再検索します');
        this.plan('reroute');
        return;
      }
      this.announce();
    }
    this.tick();
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

  // 最短距離モード：直線で近い候補を、道のりの距離（ルートサーバーの距離の行列）で並べ直す。
  // 川・線路・一方通行で直線より遠回りになるエリアを後ろへ。使えない時は直線のまま
  async roadRerank(start, ranked) {
    if (this.s.pickMode !== 'nearest' || !this.router.matrix || ranked.length < 2) return ranked;
    const top = ranked.slice(0, 6);
    let dist;
    try { dist = await this.router.matrix({ point: start.point, heading: start.bearing }, top.map((x) => x.area.center)); }
    catch { return ranked; }
    let maxScore = 0;
    for (const a of this.demand.areas.values()) maxScore = Math.max(maxScore, a.score);
    const re = top.map((x, i) => (dist[i] == null ? { ...x, utility: x.utility * 0.5 } : { ...x, road: dist[i], utility: nearestUtility(dist[i], x.area.score / (maxScore || 1)) }));
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
      firsts = fresh.slice(0, 2).map((x) => x.area);
      if (mode === 'reroute' && this.target) firsts = [this.target, ...firsts.filter((a) => a.key !== this.target.key)];
    }
    if (!firsts.length) return [];
    const plans = [];
    // 逸脱のリルートは、まだ通っていないエリアをそのまま回る
    const max = Math.max(1, Math.round(this.s.tourMax || 1));
    const tour = mode === 'reroute' && preferred && preferred.length > 1 ? preferred.slice(0, max) : this.buildTour(start, firsts[0], mode === 'extend' ? old : new Set(), planned);
    if (tour.length > 1) plans.push(tour);
    for (const a of firsts.slice(0, 2)) plans.push([a]);
    return plans;
  }

  async plan(mode, preferred = null) {
    if (this.planning) return;
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
      if (mode === 'reroute' && !preferred && this.tourRemaining().length) preferred = this.tourRemaining();
      const plans = await this.candidatePlans(mode, start, preferred);
      if (!plans.length) {
        this.emit('status', '周辺に需要エリアがありません。設定で需要スポットを取得してください');
        this.nextTryAt = this.now() + 15000;
        return;
      }
      for (const tour of plans.slice(0, 3)) {
        const dest = tour[tour.length - 1];
        const via = tour.slice(0, -1).map((a) => a.center);
        let routes;
        try {
          routes = await this.router.route({ point: start.point, heading: start.bearing }, dest.center, via.length ? { via } : undefined);
        } catch (e) {
          if (!via.length) this.badTargets.set(dest.key, this.now() + 10 * 60e3);
          this.emit('status', e.message);
          continue;
        }
        // 応答待ちの間に確定区間の終点（先へつなぐ時はルートの終わり）を通り過ぎていたら破棄
        if (commit != null && this.along > commit - 30) break;
        const remaining = this.route ? this.route.length - this.along : Infinity;
        const best = this.pickBest(routes, relaxed || remaining < 250);
        if (!best) continue;
        // 走ったばかりの道を何度も通るルートは、他の案があれば使わない（同じ所をぐるぐる回らない）
        if (tour !== plans[Math.min(plans.length, 3) - 1] && this.overlap(best) > this.s.maxOverlap) continue;
        this.apply(mode, tour, best, commit);
        return;
      }
      this.nextTryAt = this.now() + 5000;
    } finally {
      this.planning = false;
    }
  }

  // 慌ただしい操作にならない候補を選ぶ
  pickBest(routes, relaxed) {
    const v = Math.max(this.speed, 5);
    const minGap = Math.max(this.s.minFirstTurnM, v * this.s.minFirstTurnSec);
    const trackSet = this.trackGrid();
    let best = null;
    for (const r of routes) {
      const acts = r.maneuvers.filter((m) => m.action);
      if (!relaxed && acts.length && acts[0].at < minGap) continue;
      let cost = r.time;
      cost += acts.length * 15;
      cost += acts.filter((m) => m.right).length * 20; // 左側通行：右折は重め
      cost += acts.filter((m) => m.uturn).length * 400;
      for (let i = 1; i < acts.length; i++) if (acts[i].at - acts[i - 1].at < 100) cost += 60; // 連続右左折
      // 直近20分に走った道との重なり
      const samples = sampleLine(r.coords, 50);
      let hit = 0;
      for (const p of samples) if (trackSet.has(gridKey(p))) hit++;
      cost += (hit / Math.max(1, samples.length)) * 600;
      if (!best || cost < best.cost) best = { route: r, cost };
    }
    return best && best.route;
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
      if (this.pos) this.along = snapToRoute(newRoute, this.pos).along;
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
