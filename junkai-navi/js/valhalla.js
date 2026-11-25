// Valhalla ルーティング API クライアント
import { decodePolyline, cumulative } from './geo.js?v=33';

// Valhalla maneuver type → 日本語と矢印種別
export const MANEUVER = {
  7: { kind: 'straight', ja: '道なり', action: false },
  8: { kind: 'straight', ja: '直進', action: false },
  9: { kind: 'slight-right', ja: '右方向', action: true, right: true },
  10: { kind: 'right', ja: '右折', action: true, right: true },
  11: { kind: 'sharp-right', ja: '大きく右折', action: true, right: true },
  12: { kind: 'uturn', ja: 'Uターン', action: true, uturn: true },
  13: { kind: 'uturn', ja: 'Uターン', action: true, uturn: true },
  14: { kind: 'sharp-left', ja: '大きく左折', action: true },
  15: { kind: 'left', ja: '左折', action: true },
  16: { kind: 'slight-left', ja: '左方向', action: true },
  17: { kind: 'straight', ja: '直進してランプへ', action: true },
  18: { kind: 'slight-right', ja: '右側のランプへ', action: true, right: true },
  19: { kind: 'slight-left', ja: '左側のランプへ', action: true },
  20: { kind: 'slight-right', ja: '右側の出口へ', action: true, right: true },
  21: { kind: 'slight-left', ja: '左側の出口へ', action: true },
  22: { kind: 'straight', ja: '分岐を直進', action: true },
  23: { kind: 'slight-right', ja: '分岐を右方向', action: true, right: true },
  24: { kind: 'slight-left', ja: '分岐を左方向', action: true },
  25: { kind: 'straight', ja: '合流', action: false },
  26: { kind: 'roundabout', ja: 'ロータリーに進入', action: true },
  27: { kind: 'roundabout', ja: 'ロータリーから出る', action: true },
  37: { kind: 'straight', ja: '右から合流', action: false },
  38: { kind: 'straight', ja: '左から合流', action: false },
};

export class RouterError extends Error {}

export class ValhallaClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.lastCall = 0;
  }

  // 公開サーバーは毎秒1リクエストまで。最低1.5秒空ける
  async throttle() {
    const wait = this.lastCall + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  // 今いる所から各地点までの道のりの距離（m）。from: {point, heading?}, targets: [[lng,lat], …]
  async matrix(from, targets) {
    const src = { lat: from.point[1], lon: from.point[0] };
    if (from.heading != null) { src.heading = Math.round(from.heading); src.heading_tolerance = 45; }
    const body = { sources: [src], targets: targets.map((p) => ({ lat: p[1], lon: p[0] })), costing: 'auto', units: 'kilometers',
      costing_options: { auto: { use_highways: 0.1, use_tolls: 0, use_ferry: 0 } } };
    await this.throttle();
    const url = `${this.baseUrl}/sources_to_targets?json=${encodeURIComponent(JSON.stringify(body))}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    let json;
    try { const res = await fetch(url, { cache: 'no-store', signal: ctl.signal }); json = await res.json(); if (!res.ok) throw new Error(); }
    catch { throw new RouterError('距離の計算に失敗'); }
    finally { clearTimeout(timer); }
    const row = (json.sources_to_targets && json.sources_to_targets[0]) || [];
    return targets.map((_, i) => (row[i] && row[i].distance != null ? row[i].distance * 1000 : null));
  }

  // from: {point:[lng,lat], heading?}, to: [lng,lat]
  // via: 途中で通り抜けるエリアの中心 [[lng,lat], …]（止まらずに通過する 'through' 地点。別ルート案は出ない）
  async route(from, to, { alternates = 2, avoidTolls = true, via = [] } = {}) {
    const start = { lat: from.point[1], lon: from.point[0], type: 'break' };
    if (from.heading != null) { start.heading = Math.round(from.heading); start.heading_tolerance = 45; }
    const mids = via.map((p) => ({ lat: p[1], lon: p[0], type: 'through', radius: 150 }));
    const body = {
      locations: [start, ...mids, { lat: to[1], lon: to[0], type: 'break' }],
      costing: 'auto',
      costing_options: {
        auto: {
          maneuver_penalty: 15, // 曲がる回数を減らす
          use_highways: 0.1, // 流し営業なので高速は避ける
          use_tolls: avoidTolls ? 0 : 0.5,
          use_ferry: 0,
          service_penalty: 30,
        },
      },
      alternates: mids.length ? 0 : alternates,
      units: 'kilometers',
      directions_type: 'maneuvers',
    };
    await this.throttle();
    // GET にしてCORSのプリフライトを避ける
    const url = `${this.baseUrl}/route?json=${encodeURIComponent(JSON.stringify(body))}`;
    let res;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try { res = await fetch(url, { cache: 'no-store', signal: ctl.signal }); } finally { clearTimeout(timer); }
    } catch (e) {
      const err = new RouterError('ルートサーバーに接続できません');
      err.offline = true; // 通信の問題（行き先のせいではない）
      throw err;
    }
    let json = null;
    try { json = await res.json(); } catch { /* noop */ }
    if (!res.ok || !json || !json.trip) {
      throw new RouterError((json && (json.error || json.status_message)) || `ルート計算失敗 (${res.status})`);
    }
    const trips = [json.trip, ...((json.alternates || []).map((a) => a.trip).filter(Boolean))];
    return trips.map(parseTrip);
  }
}

// 「1」「15」のような路線番号だけの名前は避け、通り名を優先
function pickName(names) {
  if (!names || !names.length) return '';
  return names.find((n) => !/^[\d\-\s]+$/.test(n)) || '';
}

export function parseTrip(trip) {
  // 通過地点（through）だけなら区間は1つ。念のため複数の区間もつなげる
  let coords = [];
  const raw = [];
  for (const leg of trip.legs) {
    const pts = decodePolyline(leg.shape, 6);
    const off = coords.length ? coords.length - 1 : 0;
    coords = coords.length ? coords.concat(pts.slice(1)) : pts;
    for (const m of leg.maneuvers) raw.push({ m, idx: m.begin_shape_index + off });
  }
  const cum = cumulative(coords);
  const maneuvers = [];
  for (const { m, idx } of raw) {
    const def = MANEUVER[m.type];
    if (!def) continue; // 出発・到着など
    maneuvers.push({
      at: cum[Math.min(idx, cum.length - 1)],
      type: m.type,
      kind: def.kind,
      ja: def.ja,
      action: def.action,
      right: !!def.right,
      uturn: !!def.uturn,
      street: pickName(m.street_names) || pickName(m.begin_street_names),
      announced: null,
    });
  }
  return {
    coords,
    cum,
    length: cum[cum.length - 1],
    time: trip.summary ? trip.summary.time : trip.legs.reduce((t, l) => t + l.summary.time, 0),
    maneuvers,
  };
}
