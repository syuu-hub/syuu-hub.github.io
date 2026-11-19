// 地理計算ユーティリティ（座標は [lng, lat]）
const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function destination(p, brgDeg, distM) {
  const d = distM / R;
  const b = toRad(brgDeg);
  const lat1 = toRad(p[1]);
  const lng1 = toRad(p[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 =
    lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lng2), toDeg(lat2)];
}

// Valhalla の polyline6 をデコード → [[lng,lat],...]
export function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

export function cumulative(coords) {
  const cum = new Array(coords.length);
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversine(coords[i - 1], coords[i]);
  return cum;
}

// 平面近似で点を線分に投影
function projectOnSegment(p, a, b) {
  const kx = Math.cos(toRad(p[1])) * 111320;
  const ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx, py = ay + t * dy;
  return { t, dist: Math.sqrt(px * px + py * py) };
}

// ルート上への最近傍スナップ。prevAlong を与えると後戻りしにくくする
export function snapToRoute(route, p, prevAlong = null) {
  const { coords, cum } = route;
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const r = projectOnSegment(p, coords[i], coords[i + 1]);
    const along = cum[i] + r.t * (cum[i + 1] - cum[i]);
    let score = r.dist;
    if (prevAlong != null) {
      if (along < prevAlong - 40) score += 60; // 後戻りペナルティ
      if (along > prevAlong + 400) score += 40; // 飛び越しペナルティ（交差・並走対策）
    }
    if (!best || score < best.score) best = { score, dist: r.dist, along, index: i };
  }
  return best;
}

// ルート上の距離 along の位置と進行方位
export function pointAt(route, along) {
  const { coords, cum } = route;
  if (along <= 0) return { point: coords[0], bearing: bearing(coords[0], coords[1] || coords[0]), index: 0 };
  const total = cum[cum.length - 1];
  if (along >= total) {
    const n = coords.length;
    return { point: coords[n - 1], bearing: bearing(coords[Math.max(0, n - 2)], coords[n - 1]), index: n - 2 };
  }
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= along) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (along - cum[lo]) / seg : 0;
  const a = coords[lo], b = coords[hi];
  return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearing(a, b), index: lo, t };
}

// along の区間 [from, to] の座標列を切り出す
export function sliceRoute(route, from, to = Infinity) {
  const { coords, cum } = route;
  const total = cum[cum.length - 1];
  from = Math.max(0, from); to = Math.min(total, to);
  if (to <= from) return [pointAt(route, from).point];
  const out = [pointAt(route, from).point];
  for (let i = 0; i < coords.length; i++) if (cum[i] > from && cum[i] < to) out.push(coords[i]);
  out.push(pointAt(route, to).point);
  return out;
}

// 等間隔サンプリング
export function sampleLine(coords, stepM) {
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc >= stepM) { out.push(coords[i]); acc = 0; }
  }
  return out;
}
