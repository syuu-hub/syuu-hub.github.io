// 現在地の3Dの車（黒いセダン）：地図の立体（fill-extrusion）で描くので、地図の傾き・回転と一緒に本物の立体として見える
// 部品は実際の車の大きさ（全長4.8m）で作り、画面で見やすい大きさに拡大する

const CAR_LEN = 4.8;
// 部品：中心 (x 右, y 前) と大きさ (w 幅, l 長さ)、下の高さ b・上の高さ h（m）、色 c、角の面取り r
const PARTS = [
  // 白い縁取り（地面に薄く）：暗い地図でも車の形がわかるように
  { x: 0, y: 0, w: 2.2, l: 5.15, b: 0, h: 0.03, c: '#ffffff', r: 0.55 },
  // タイヤ
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ x: sx * 0.8, y: sy * 1.45, w: 0.3, l: 0.72, b: 0, h: 0.62, c: '#050505', r: 0 }))),
  // 車体（下）
  { x: 0, y: 0, w: 1.82, l: 4.8, b: 0.24, h: 0.86, c: '#111317', r: 0.42 },
  // ボンネットとトランクの上面（少し高く、車体より細い）
  { x: 0, y: 1.55, w: 1.66, l: 1.5, b: 0.86, h: 0.9, c: '#16191e', r: 0.3 },
  { x: 0, y: -1.85, w: 1.66, l: 0.95, b: 0.86, h: 0.92, c: '#16191e', r: 0.25 },
  // 窓（キャビン）
  { x: 0, y: -0.2, w: 1.58, l: 2.55, b: 0.86, h: 1.3, c: '#55687e', r: 0.45 },
  // 屋根
  { x: 0, y: -0.3, w: 1.46, l: 1.65, b: 1.3, h: 1.42, c: '#08090b', r: 0.3 },
  // ドアミラー
  { x: -1.0, y: 0.95, w: 0.22, l: 0.14, b: 0.82, h: 0.98, c: '#111418', r: 0 },
  { x: 1.0, y: 0.95, w: 0.22, l: 0.14, b: 0.82, h: 0.98, c: '#111418', r: 0 },
  // テールランプ・ヘッドライト（後ろ・前の面に少し出して）
  { x: -0.6, y: -2.41, w: 0.48, l: 0.06, b: 0.6, h: 0.78, c: '#ff3b30', r: 0 },
  { x: 0.6, y: -2.41, w: 0.48, l: 0.06, b: 0.6, h: 0.78, c: '#ff3b30', r: 0 },
  { x: -0.6, y: 2.41, w: 0.45, l: 0.06, b: 0.6, h: 0.74, c: '#fff4c2', r: 0 },
  { x: 0.6, y: 2.41, w: 0.45, l: 0.06, b: 0.6, h: 0.74, c: '#fff4c2', r: 0 },
  // ナンバープレート
  { x: 0, y: -2.42, w: 0.5, l: 0.04, b: 0.42, h: 0.56, c: '#e9eef2', r: 0 },
];

// 面取りした長方形（車の座標、m）
function box({ x, y, w, l, r }) {
  const hw = w / 2, hl = l / 2, c = Math.min(r, hw * 0.9, hl * 0.9);
  const pts = c > 0
    ? [[-hw + c, -hl], [hw - c, -hl], [hw, -hl + c], [hw, hl - c], [hw - c, hl], [-hw + c, hl], [-hw, hl - c], [-hw, -hl + c]]
    : [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]];
  return pts.map(([px, py]) => [px + x, py + y]);
}

// 地図の拡大率で、1ピクセルが何メートルか（MapLibre の 512px タイル）
export const metersPerPixel = (lat, zoom) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

// center [lng, lat]、bearing（度、北から時計回り）、全長 lenM（m）→ GeoJSON
export function carGeoJSON(center, bearing, lenM) {
  const s = lenM / CAR_LEN;
  const rad = (bearing * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const kx = 111320 * Math.cos((center[1] * Math.PI) / 180), ky = 110540;
  const toLngLat = ([x, y]) => {
    const e = (x * cos + y * sin) * s, n = (-x * sin + y * cos) * s;
    return [center[0] + e / kx, center[1] + n / ky];
  };
  const features = PARTS.map((p) => {
    const ring = box(p).map(toLngLat);
    ring.push(ring[0]);
    return { type: 'Feature', properties: { c: p.c, b: p.b * s, h: p.h * s }, geometry: { type: 'Polygon', coordinates: [ring] } };
  });
  // 地面の影（少し後ろ・大きめ）
  const shadow = box({ x: 0.15, y: -0.25, w: 2.5, l: 5.5, r: 0.9 }).map(toLngLat);
  shadow.push(shadow[0]);
  features.unshift({ type: 'Feature', properties: { shadow: 1 }, geometry: { type: 'Polygon', coordinates: [shadow] } });
  return { type: 'FeatureCollection', features };
}
