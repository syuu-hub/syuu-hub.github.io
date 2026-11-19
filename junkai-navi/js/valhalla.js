// Valhalla ルーティング API クライアント
import { decodePolyline, cumulative } from './geo.js';

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

  // from: {point:[lng,lat], heading?}, to: [lng,lat]
  async route(from, to, { alternates = 2, avoidTolls = true } = {}) {
    const start = { lat: from.point[1], lon: from.point[0], type: 'break' };
    if (from.heading != null) { start.heading = Math.round(from.heading); start.heading_tolerance = 45; }
    const body = {
      locations: [start, { lat: to[1], lon: to[0], type: 'break' }],
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
      alternates,
      units: 'kilometers',
      directions_type: 'maneuvers',
    };
    await this.throttle();
    // GET にしてCORSのプリフライトを避ける
    const url = `${this.baseUrl}/route?json=${encodeURIComponent(JSON.stringify(body))}`;
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      throw new RouterError('ルートサーバーに接続できません');
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

export function parseTrip(trip) {
  const leg = trip.legs[0];
  const coords = decodePolyline(leg.shape, 6);
  const cum = cumulative(coords);
  const maneuvers = [];
  for (const m of leg.maneuvers) {
    const def = MANEUVER[m.type];
    if (!def) continue; // 出発・到着など
    maneuvers.push({
      at: cum[Math.min(m.begin_shape_index, cum.length - 1)],
      type: m.type,
      kind: def.kind,
      ja: def.ja,
      action: def.action,
      right: !!def.right,
      uturn: !!def.uturn,
      street: (m.street_names && m.street_names[0]) || (m.begin_street_names && m.begin_street_names[0]) || '',
      announced: null,
    });
  }
  return {
    coords,
    cum,
    length: cum[cum.length - 1],
    time: trip.summary ? trip.summary.time : leg.summary.time,
    maneuvers,
  };
}
