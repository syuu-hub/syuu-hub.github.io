// 需要エンジン：時間帯・曜日・天気・鉄道・イベント・自分の乗車記録から需要エリアを算出
import { haversine, bearing, angleDiff } from './geo.js?v=6';

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

function timeFactor(cat, date) {
  const h = date.getHours();
  const dow = date.getDay(); // 0=日
  const weekend = dow === 0 || dow === 6;
  let f = (P[cat] || P.station)[h];
  if (cat === 'hospital' && weekend) f *= 0.3;
  if (cat === 'nightlife' && (dow === 5 || dow === 6) && (h >= 20 || h <= 3)) f *= 1.3; // 金土の夜
  if (cat === 'station' && weekend && (h === 7 || h === 8)) f *= 0.6; // 休日は朝ラッシュなし
  if (cat === 'custom') f = 1;
  return f;
}

function weatherFactor(cat, weather) {
  if (!weather || weather === 'clear') return 1;
  const heavy = weather === 'heavy';
  if (cat === 'station') return heavy ? 2.0 : 1.6;
  return heavy ? 1.7 : 1.4;
}

function eventFactor(ev, now) {
  const end = new Date(ev.end).getTime();
  const t = now.getTime();
  const from = end - 30 * 60e3, to = end + 60 * 60e3;
  if (t < from || t > to) return 0;
  const peak = end + 10 * 60e3;
  const w = t < peak ? (t - from) / (peak - from) : 1 - (t - peak) / (to - peak);
  return Math.max(0, w) * ({ s: 1, m: 3, l: 6 }[ev.size] || 3);
}

const CELL_LAT = 0.004, CELL_LNG = 0.005; // 約450m四方
const cellKey = (p) => `${Math.floor(p[1] / CELL_LAT)}:${Math.floor(p[0] / CELL_LNG)}`;
const cellCenter = (key) => {
  const [a, b] = key.split(':').map(Number);
  return [(b + 0.5) * CELL_LNG, (a + 0.5) * CELL_LAT];
};

export class DemandEngine {
  constructor() {
    this.spots = []; // {id,name,lng,lat,cat}
    this.events = []; // {id,name,lng,lat,end,size}
    this.pickups = []; // {lng,lat,t}
    this.csvRides = []; // タクシーアナライザの乗車実績 {lng,lat,t,name,fare}
    this.weather = 'clear'; // clear | rain | heavy
    this.railDisruption = false;
    this.areas = new Map(); // key -> {key, center, name, score, raw}
    this.visited = new Map(); // key -> 訪問時刻
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
      let v = (BASE[s.cat] || 0.3) * timeFactor(s.cat, now) * weatherFactor(s.cat, this.weather);
      if (s.cat === 'station' && this.railDisruption) v *= 1.8;
      if (s.name) add([s.lng, s.lat], v, s.name, BASE[s.cat] || 0.3);
      else add([s.lng, s.lat], v, s.cat === 'nightlife' ? '繁華街' : CAT_JA[s.cat], 0.01);
    }
    for (const ev of this.events) {
      const v = eventFactor(ev, now);
      if (v > 0) add([ev.lng, ev.lat], v, ev.name, 10);
    }
    // 自分の乗車記録：同じ曜日タイプ・前後1時間の実績を重み付け
    const h = now.getHours();
    const wk = now.getDay() === 0 || now.getDay() === 6;
    for (const p of this.pickups) {
      const d = new Date(p.t);
      const dh = Math.min(Math.abs(d.getHours() - h), 24 - Math.abs(d.getHours() - h));
      if (dh > 1) continue;
      const sameType = (d.getDay() === 0 || d.getDay() === 6) === wk;
      const ageDays = (now - d) / 864e5;
      const v = 0.8 * (dh === 0 ? 1 : 0.5) * (sameType ? 1 : 0.4) * Math.exp(-ageDays / 60);
      add([p.lng, p.lat], v, '乗車実績', 0.005);
    }

    // タクシーアナライザの乗車実績：同じ時間帯・曜日タイプほど重く、運賃が高いほど少し重く
    for (const p of this.csvRides) {
      const d = new Date(p.t);
      const dh = Math.min(Math.abs(d.getHours() - h), 24 - Math.abs(d.getHours() - h));
      const tw = dh === 0 ? 1 : dh === 1 ? 0.5 : dh === 2 ? 0.2 : 0.03; // 時間帯外も少しだけ残す
      const sameType = (d.getDay() === 0 || d.getDay() === 6) === wk;
      const ageDays = Math.max(0, (now - d) / 864e5);
      const fareW = 1 + 0.4 * Math.min(2, (p.fare || 0) / 3000);
      const v = tw * (sameType ? 1 : 0.5) * Math.exp(-ageDays / 365) * fareW;
      add([p.lng, p.lat], v, p.name || '乗車実績', p.name ? 0.5 + v : 0.005);
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

  markVisited(key, now = Date.now()) { if (key) this.visited.set(key, now); }

  // 次の目標エリアを選ぶ
  // from: 出発点, heading: 進行方位, opts.center/radiusM: 営業エリア, opts.exclude: 除外キー
  rank(from, heading, { center, radiusM = 6000, exclude = new Set(), now = Date.now(), minDistM = 700 } = {}) {
    const list = [];
    for (const a of this.areas.values()) {
      if (exclude.has(a.key)) continue;
      const d = haversine(from, a.center);
      if (d < minDistM) continue;
      if (center && haversine(center, a.center) > radiusM) continue;
      let u = a.score / (1 + d / 2500);
      if (heading != null) {
        const diff = angleDiff(heading, bearing(from, a.center));
        u *= 1 - 0.4 * (diff / 180); // 前方を優先（Uターンを減らす）
      }
      const v = this.visited.get(a.key);
      if (v) {
        const mins = (now - v) / 60e3;
        if (mins < 25) u *= 0.15 + 0.85 * (mins / 25); // 直近に回ったエリアは後回し
      }
      list.push({ area: a, utility: u, dist: d });
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
