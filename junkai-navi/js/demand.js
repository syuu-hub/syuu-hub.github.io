// 需要エンジン：時間帯・曜日・天気・鉄道・登録地点・タクシーアナライザの乗車実績から需要エリアを算出（イベントは使わない）
// （乗車の記録はタクシーアナライザで行い、このアプリは記録したデータに基づいて案内するだけ）
import { haversine, bearing, angleDiff } from './geo.js?v=31';
import { profFactor } from './profile.js?v=31';
import { isOffDay } from './calendar.js?v=31';
import { DEFAULT_PARAMS, prep, localCounts, timeWeight, nowInfo } from './model.js?v=31';

// 時間帯プロファイル（0〜23時、0〜1）
const P = {
  station: [1.0, 0.7, 0.2, 0.1, 0.1, 0.2, 0.5, 0.9, 1.0, 0.7, 0.5, 0.5, 0.6, 0.5, 0.5, 0.6, 0.7, 0.9, 1.0, 0.9, 0.8, 0.8, 0.9, 1.0],
  hotel: [0.3, 0.2, 0.1, 0.1, 0.2, 0.5, 0.9, 1.0, 0.9, 0.7, 0.5, 0.4, 0.4, 0.4, 0.5, 0.6, 0.6, 0.6, 0.6, 0.5, 0.5, 0.6, 0.6, 0.5],
  hospital: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.8, 1.0, 1.0, 0.9, 0.8, 0.8, 0.9, 0.9, 0.7, 0.5, 0.3, 0.2, 0.2, 0.1, 0.1, 0.1],
  nightlife: [1.0, 0.9, 0.7, 0.5, 0.4, 0.3, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.1, 0.2, 0.3, 0.5, 0.6, 0.8, 0.9, 1.0],
  shopping: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.1, 0.2, 0.5, 0.6, 0.6, 0.6, 0.6, 0.7, 0.8, 0.9, 0.9, 0.8, 0.6, 0.3, 0.1, 0.05],
};
const BASE = { station: 1.0, hotel: 0.5, hospital: 0.6, nightlife: 0.12, shopping: 0.6, custom: 1.0 };
export const CAT_JA = { station: '駅', hotel: 'ホテル', hospital: '病院', nightlife: '繁華街', shopping: '商業施設', custom: '登録地点' };

function timeFactor(cat, date, spot = null) {
  const h = date.getHours();
  const dow = date.getDay(); // 0=日
  const weekend = isOffDay(date); // 祝日・年末年始も休日の傾向
  let f = (P[cat] || P.station)[h];
  if (cat === 'hospital' && weekend) f *= 0.3;
  if (cat === 'nightlife' && (dow === 5 || dow === 6) && (h >= 20 || h <= 3)) f *= 1.3; // 金土の夜
  if (cat === 'station' && weekend && (h === 7 || h === 8)) f *= 0.6; // 休日は朝ラッシュなし
  // 登録地点：営業ログの乗車時刻・曜日、または自分で指定した時間帯・曜日（指定がなければ一日中同じ）
  if (cat === 'custom') f = spot && spot.prof ? profFactor(spot.prof, date) : 1;
  return f;
}

function weatherFactor(cat, weather) {
  if (!weather || weather === 'clear') return 1;
  const heavy = weather === 'heavy';
  if (cat === 'station') return heavy ? 2.0 : 1.6;
  return heavy ? 1.7 : 1.4;
}


const CELL_LAT = 0.004, CELL_LNG = 0.005; // 約450m四方
const cellKey = (p) => `${Math.floor(p[1] / CELL_LAT)}:${Math.floor(p[0] / CELL_LNG)}`;

// ===== 行き先の選び方（需要の高さ優先）の根拠 =====
// 空車の目的は「次のお客様を早く・高い運賃で乗せる」こと。タクシーの巡回先の推薦の研究では、
// 行き先までの移動の手間と、そこで乗車が見つかる見込みを合わせて、空車の時間・距離あたりの期待収入が最大の所を選ぶ
// （Ge ほか KDD 2010、Yuan ほか UbiComp 2011「T-Finder」、Powell ほか SSTD 2011、Qu ほか KDD 2014）。
// ここでは 期待収入 ÷（行き先までの時間 ＋ そこで乗車が見つかるまでの時間）で比べる
//   ・行き先までの時間：直線距離 × 道路の迂回係数1.3（Ballou ほか 2002）÷ 市街地の平均速度 20km/h。後ろの行き先はUターンの分だけ遠い扱い
//   ・乗車が見つかるまでの時間：乗車をポアソン過程とみなすと平均 1/λ。λ は需要の密度に比例するとして、
//     営業ログの「空車の時間あたりの乗車数」で目盛りを合わせる（需要が中くらいのエリアで 1/その数）
//   ・期待収入：そのエリアで乗せた時の運賃の平均（件数が少ない所は全体の平均に寄せる）
export const CIRCUITY = 1.3;
export const SPEED_KMH = 20;
// エリア a へ effM（m）走って向かう時の、空車の時間あたりの期待収入（運賃は平均を1とした比）
export function expectedRevenueRate(a, effM, searchMin, refDens) {
  const dens = Math.max(1e-9, a.dens || a.score * a.score);
  const search = Math.min(600, searchMin * (refDens / dens));
  return (a.fare || 1) / (travelMinutes(effM) + search);
}
export const travelMinutes = (effM) => (effM * CIRCUITY) / ((SPEED_KMH * 1000) / 60);

const cellCenter = (key) => {
  const [a, b] = key.split(':').map(Number);
  return [(b + 0.5) * CELL_LNG, (a + 0.5) * CELL_LAT];
};

// 最短距離モードの点数：走る距離 effM（m）が短いほど高い。需要の比率 share（0〜1）は1割5分だけ効かせる
export const nearestUtility = (effM, share) => (0.85 + 0.15 * share) / (effM + 200);

export class DemandEngine {
  constructor() {
    this.spots = []; // {id,name,lng,lat,cat}
    this.csvRides = []; // タクシーアナライザの乗車実績 {lng,lat,t,name,fare}
    this.model = null; // 営業ログの交差検証で選んだ需要モデルの設定（js/model.js の fitModel）
    this.searchMin = 30; // 需要が中くらいのエリアで、乗車が見つかるまでの平均の時間（分）。営業ログの空車の時間から
    this.weather = 'clear'; // clear | rain | heavy
    this.railDisruption = false;
    this.areas = new Map(); // key -> {key, center, name, score, raw}
    this.visited = new Map(); // key -> { t: 回った時刻, c: 中心 }
  }

  // 需要エリアを再計算（EMA で平滑化して急変を防ぐ）
  update(now = new Date(), alpha = 0.35) {
    const raw = new Map();
    const add = (p, v, name, w) => {
      const k = cellKey(p);
      let a = raw.get(k);
      if (!a) { a = { score: 0, name: null, nameW: -1, pts: [] }; raw.set(k, a); }
      a.score += v;
      a.pts.push([p, v]);
      if (name && w > a.nameW) { a.name = name; a.nameW = w; }
    };
    for (const s of this.spots) {
      let v = (BASE[s.cat] || 0.3) * timeFactor(s.cat, now, s) * weatherFactor(s.cat, this.weather);
      if (s.cat === 'station' && this.railDisruption) v *= 1.8;
      // タクシーアナライザから取り込んだ地点は、乗車が多いほど重く（1回=1倍、4回=1.5倍、上限3倍）
      if (s.rides > 1) v *= Math.min(3, 0.5 + 0.5 * Math.sqrt(s.rides));
      if (s.name) add([s.lng, s.lat], v, s.name, BASE[s.cat] || 0.3);
      else add([s.lng, s.lat], v, s.cat === 'nightlife' ? '繁華街' : CAT_JA[s.cat], 0.01);
    }
    // タクシーアナライザの乗車実績：カーネル密度推定（場所・時刻、経験ベイズの縮小つき。js/model.js）
    // 設定は営業ログの交差検証で選んだもの（読み込んでいなければ初期値）。乗車のあった場所だけを行き先の候補にし、
    // その場所の需要は、まわり（幅 hs）の乗車も含めた密度で見る
    if (this.csvRides.length) {
      const prm = (this.model && this.model.params) || DEFAULT_PARAMS;
      const { P, nLoc, origin } = this.rideCache(prm.hs);
      const nw = nowInfo(now);
      const w = P.map((r, i) => timeWeight(r, nw, prm.st, nLoc[i] / (nLoc[i] + prm.K), prm.dayPen) * Math.exp(-Math.max(0, (now - this.csvRides[i].t) / 864e5) / 200));
      const cells = new Map();
      this.csvRides.forEach((p, i) => {
        const k = cellKey([p.lng, p.lat]);
        let c = cells.get(k);
        if (!c) { c = { x: 0, y: 0, sw: 0, name: null, nameW: -1 }; cells.set(k, c); }
        const v = w[i] + 1e-6;
        c.x += P[i].x * v; c.y += P[i].y * v; c.sw += v;
        if (p.name && v > c.nameW) { c.name = p.name; c.nameW = v; }
      });
      const fares = P.filter((r) => r.fare > 0).map((r) => r.fare);
      const meanFare = fares.length ? fares.reduce((x, y) => x + y, 0) / fares.length : 0;
      const hs = prm.hs, lim = (4 * hs) ** 2;
      for (const [k, c] of cells) {
        const cx = c.x / c.sw, cy = c.y / c.sw;
        let dens = 0, fw = 0, fs = 0;
        for (let j = 0; j < P.length; j++) {
          const dx = cx - P[j].x, dy = cy - P[j].y, d2 = dx * dx + dy * dy;
          if (d2 >= lim) continue;
          const kw = w[j] * Math.exp(-d2 / (2 * hs * hs));
          dens += kw;
          if (P[j].fare > 0) { fw += kw; fs += kw * P[j].fare; }
        }
        const center = [origin[0] + cx / (111320 * Math.cos((origin[1] * Math.PI) / 180)), origin[1] + cy / 110540];
        add(center, dens, c.name || '乗車実績', c.name ? 0.5 + dens : 0.005);
        // 期待運賃：件数が少ない所は全体の平均に寄せる（乗車2件分）
        const ra = raw.get(k) || raw.get(cellKey(center));
        if (ra && meanFare > 0) ra.fare = (fs + 2 * meanFare) / (fw + 2) / meanFare;
      }
    }

    const next = new Map();
    const keys = new Set([...raw.keys(), ...this.areas.keys()]);
    for (const k of keys) {
      const r = raw.get(k);
      const prev = this.areas.get(k);
      const target = r ? Math.sqrt(r.score) : 0; // 大きな集積を少し抑える
      const score = prev ? prev.score + alpha * (target - prev.score) : target;
      if (score < 0.02) continue;
      // 重心（需要の重み付き）を目的地にする
      let center = prev ? prev.center : cellCenter(k);
      if (r) {
        let sw = 0, x = 0, y = 0;
        for (const [p, v] of r.pts) { x += p[0] * v; y += p[1] * v; sw += v; }
        if (sw > 0) center = [x / sw, y / sw];
      }
      const dens = r ? r.score : prev && prev.dens ? prev.dens * (1 - alpha) : score * score;
      next.set(k, { key: k, center, score, dens, fare: (r && r.fare) || (prev && prev.fare) || 1, name: (r && r.name) || (prev && prev.name) || null });
    }
    this.areas = next;
    return next;
  }

  // 乗車実績の計算用の値（乗車が変わった時・場所の幅が変わった時だけ計算し直す）
  rideCache(hs) {
    const c = this._rc;
    if (c && c.rides === this.csvRides && c.n === this.csvRides.length && c.hs === hs) return c;
    const origin = [this.csvRides[0].lng, this.csvRides[0].lat];
    const P = prep(this.csvRides, origin);
    this._rc = { rides: this.csvRides, n: this.csvRides.length, hs, P, origin, nLoc: localCounts(P, hs) };
    return this._rc;
  }

  markVisited(key, now = Date.now(), center = null) {
    if (!key) return;
    const c = center || (this.areas.get(key) && this.areas.get(key).center) || (this.visited.get(key) && this.visited.get(key).c) || null;
    this.visited.set(key, { t: now, c });
  }

  // 回ってから revisitMin 分以内のエリアの中心
  recentVisited(now, revisitMin) {
    const out = [];
    for (const [k, v] of this.visited) {
      if (now - v.t < revisitMin * 60e3) out.push({ key: k, c: v.c, t: v.t });
      else if (now - v.t > 6 * 3600e3) this.visited.delete(k); // 古い記録は捨てる
    }
    return out;
  }

  // 次の目標エリアを選ぶ
  // from: 出発点, heading: 進行方位, opts.center/radiusM: 営業エリア, opts.exclude: 除外キー
  // strict：回ってから revisitMin 分以内のエリアと、その近く（nearM 以内）は候補にしない（同じ所をぐるぐる回らない）
  //         false なら候補には残し、点数を大きく下げるだけ（他に行き先が無い時の予備）
  // pick：'nearest'＝需要のあるエリア（一番高いエリアの minShare 以上）のうち、近い順（後ろのエリアは遠い扱い）
  //       'demand' ＝需要の高さと距離のかね合い（需要が高ければ少し遠くても選ぶ）
  rank(from, heading, { center, radiusM = 6000, exclude = new Set(), now = Date.now(), minDistM = 700, revisitMin = 60, nearM = 500, strict = true, pick = 'demand', minShare = 0.25 } = {}) {
    const list = [];
    const recent = this.recentVisited(now, revisitMin);
    let maxScore = 0;
    for (const a of this.areas.values()) maxScore = Math.max(maxScore, a.score);
    // 需要が中くらいのエリアの密度（乗車が見つかるまでの時間の目盛り）
    const ds = [...this.areas.values()].map((a) => a.dens || a.score * a.score).sort((x, y) => x - y);
    const refDens = ds.length ? ds[ds.length >> 1] : 1;
    for (const a of this.areas.values()) {
      if (pick === 'nearest' && a.score < maxScore * minShare) continue; // 需要が小さいエリアは行き先にしない
      if (exclude.has(a.key)) continue;
      const d = haversine(from, a.center);
      if (d < minDistM) continue;
      if (center && haversine(center, a.center) > radiusM) continue;
      const diff = heading != null ? angleDiff(heading, bearing(from, a.center)) : 0;
      let u;
      if (pick === 'nearest') {
        // 走る距離が短いほど良い。後ろのエリアはUターン・回り込みが要るので遠い扱い。需要は同じくらいの近さの時の決め手に少しだけ
        u = nearestUtility(d * (1 + 0.6 * (diff / 180)), a.score / (maxScore || 1));
      } else {
        // 空車の時間あたりの期待収入（上の「行き先の選び方の根拠」）。後ろの行き先はUターン・回り込みの分だけ遠い扱い
        u = expectedRevenueRate(a, d * (1 + 0.6 * (diff / 180)), this.searchMin, refDens);
      }
      // 直近に回ったエリア（そのものか、すぐ近く）
      let last = null;
      for (const r of recent) if (r.key === a.key || (r.c && haversine(r.c, a.center) < nearM)) if (!last || r.t > last) last = r.t;
      if (last != null) {
        if (strict) continue;
        u *= 0.05 + 0.95 * ((now - last) / 60e3 / revisitMin) ** 2;
      }
      list.push({ area: a, utility: u, dist: d, diff });
    }
    list.sort((x, y) => y.utility - x.utility);
    return list;
  }

  utilityOf(key, from, heading, opts) {
    const r = this.rank(from, heading, { ...opts, minDistM: 0 }).find((x) => x.area.key === key);
    return r ? r.utility : 0;
  }

  areaName(a) {
    return a && a.name ? `${a.name}周辺` : '需要エリア';
  }

  level(a) {
    if (!a) return 0;
    let max = 0;
    for (const x of this.areas.values()) max = Math.max(max, x.score);
    return max > 0 ? Math.max(1, Math.round((a.score / max) * 5)) : 0;
  }

  heatmapGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: [...this.areas.values()].map((a) => ({
        type: 'Feature',
        properties: { score: a.score },
        geometry: { type: 'Point', coordinates: a.center },
      })),
    };
  }
}
