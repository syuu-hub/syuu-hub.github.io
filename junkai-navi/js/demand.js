// 需要エンジン：時間帯・曜日・天気・鉄道・登録地点・タクシーアナライザの乗車実績から需要エリアを算出（イベントは使わない）
// （乗車の記録はタクシーアナライザで行い、このアプリは記録したデータに基づいて案内するだけ）
import { haversine, bearing, angleDiff } from './geo.js?v=30';
import { profFactor } from './profile.js?v=30';
import { isOffDay } from './calendar.js?v=30';

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
// 隣のエリアの需要も少し足す（辺で接する隣は3割、斜めは2割）。乗車が続けて見つかる「面」の需要を高く見て、
// エリアの区切りの線をまたいだだけで需要が分かれて低く見えないように
const NEIGHBOR_W = [[-1, 0, 0.3], [1, 0, 0.3], [0, -1, 0.3], [0, 1, 0.3], [-1, -1, 0.2], [-1, 1, 0.2], [1, -1, 0.2], [1, 1, 0.2]];

// ===== タクシーアナライザの乗車実績の重み =====
const DAY_MIN = 1440;
const TIME_SIGMA_MIN = 60; // 時刻の近さ：前後60分で6割、2時間で1割5分ほど
const TREND_K = 8; // エリアの乗車がこの件数あると、時刻・曜日の傾向を半分の強さで使う
const KERNEL_MEAN = (TIME_SIGMA_MIN * Math.sqrt(2 * Math.PI)) / DAY_MIN; // 時刻の重みの1日の平均
// 時刻・曜日の傾向をどれだけ信じるか（0〜1）。エリアの乗車が少ないうちは弱く、多くなるほど強く
// 実際の営業ログで「他の日の乗車から、その日の乗車場所を当てる」検証をすると、1回だけの乗車の時刻で強く重み付けすると
// 偶然の時刻を拾って外れやすく、乗車が何回もある場所だけ時刻の傾向を強く使う方がよく当たった
export const trendStrength = (n) => n / (n + TREND_K);
// 傾向の強さ c で、時刻の重みの1日の平均が1になるようにする（乗車が多いエリアの需要が、時刻の重みで全体に下がらないように）
export const trendNorm = (c) => 1 / (1 - c + c * KERNEL_MEAN);
// 1件の乗車の、時刻 now の需要への重み
// ・時刻：分単位でなめらかに（10:50の乗車は11:10にもよく効く）
// ・曜日：同じ曜日 1、平日／休日（土日・祝日・年末年始）が同じなら少し下げ、違えばもっと下げる
// ・新しい乗車ほど重く（200日で約4割）、運賃が高いほど少し重く
export function rideWeight(p, now, c = 0.5) {
  const d = new Date(p.t);
  const md = ((d.getHours() * 60 + d.getMinutes()) - (now.getHours() * 60 + now.getMinutes()) + DAY_MIN * 2) % DAY_MIN;
  const dm = Math.min(md, DAY_MIN - md);
  const tw = 1 - c + c * Math.exp(-(dm * dm) / (2 * TIME_SIGMA_MIN * TIME_SIGMA_MIN));
  const offR = isOffDay(d), offN = isOffDay(now);
  const dw = offR !== offN ? 1 - 0.5 * c : d.getDay() === now.getDay() ? 1 : 1 - 0.15 * c;
  const ageDays = Math.max(0, (now - d) / 864e5);
  const fareW = 1 + 0.4 * Math.min(2, (p.fare || 0) / 3000);
  return tw * dw * Math.exp(-ageDays / 200) * fareW;
}

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
    // タクシーアナライザの乗車実績：乗車の多い場所を基本に、時刻・曜日が近い乗車ほど重く（傾向の強さは件数しだい）
    const perCell = new Map();
    for (const p of this.csvRides) { const k = cellKey([p.lng, p.lat]); perCell.set(k, (perCell.get(k) || 0) + 1); }
    for (const p of this.csvRides) {
      const c = trendStrength(perCell.get(cellKey([p.lng, p.lat])));
      const v = rideWeight(p, now, c) * trendNorm(c);
      add([p.lng, p.lat], v, p.name || '乗車実績', p.name ? 0.5 + v : 0.005);
    }
    // 隣のエリアの需要を少し足す（需要のあるエリアだけ。何もない所を行き先にはしない）
    const own = new Map([...raw].map(([k, a]) => [k, a.score]));
    for (const [k, a] of raw) {
      const [y, x] = k.split(':').map(Number);
      for (const [dy, dx, w] of NEIGHBOR_W) { const o = own.get(`${y + dy}:${x + dx}`); if (o) a.score += w * o; }
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
      next.set(k, { key: k, center, score, name: (r && r.name) || (prev && prev.name) || null });
    }
    this.areas = next;
    return next;
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
        u = a.score / (1 + d / 2500);
        u *= 1 - 0.4 * (diff / 180); // 前方を優先（Uターンを減らす）
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
