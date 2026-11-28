// 画面の昼・夜（見やすさ・まぶしさ）
//
// ・夜の運転では、明るい画面はまぶしく、暗さに慣れた目（暗順応）を乱す。車の表示は周りの明るさに合わせて
//   暗くするのがよい（ISO 15008：車載の表示の見やすさ）。スマホの「ダークモード」設定ではなく、
//   今いる所の日の出・日の入りで、画面と地図を自動で切り替える
// ・日の出・日の入りは、米国海軍天文台の計算法（Almanac for Computers, 1990。太陽の中心が地平線の下 0.833度）で求める

const RAD = Math.PI / 180;
const mod = (a, n) => ((a % n) + n) % n;

// date の日（その場所の暦の日）の日の出・日の入り（Date）。白夜・極夜は null
export function sunTimes(date, lat, lng) {
  const y = date.getFullYear(), mo = date.getMonth(), d = date.getDate();
  const N = Math.round((Date.UTC(y, mo, d) - Date.UTC(y, 0, 0)) / 864e5); // 1月1日が1
  const lngHour = lng / 15;
  const calc = (rise) => {
    const t = N + ((rise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    const L = mod(M + 1.916 * Math.sin(M * RAD) + 0.020 * Math.sin(2 * M * RAD) + 282.634, 360);
    let RA = mod(Math.atan(0.91764 * Math.tan(L * RAD)) / RAD, 360);
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * Math.sin(L * RAD), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD));
    if (cosH > 1 || cosH < -1) return null;
    const H = (rise ? 360 - Math.acos(cosH) / RAD : Math.acos(cosH) / RAD) / 15;
    const UT = mod(H + RA - 0.06571 * t - 6.622 - lngHour, 24);
    // その日（端末の暦）の0時〜24時に入るように
    const mid = new Date(y, mo, d).getTime();
    let ms = Date.UTC(y, mo, d) + UT * 3600e3;
    while (ms < mid) ms += 864e5;
    while (ms >= mid + 864e5) ms -= 864e5;
    return new Date(ms);
  };
  return { sunrise: calc(true), sunset: calc(false) };
}

// 夜か（日の入りから日の出まで）
export function isDark(now, lat, lng) {
  const { sunrise, sunset } = sunTimes(now, lat, lng);
  if (!sunrise || !sunset) return false;
  return now < sunrise || now >= sunset;
}

// ===== 色 =====
const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], red: [255, 0, 0, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1] };
export const isColorString = (s) => typeof s === 'string' && (/^\s*(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(s) || s.toLowerCase() in NAMED);

// 色の文字列 → [r, g, b, a]（0〜255、a は 0〜1）。読めなければ null
export function parseColor(s) {
  s = String(s).trim().toLowerCase();
  if (s in NAMED) return NAMED[s].slice();
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    const [r, g, b] = hslToRgb(p[0] / 360, p[1] / 100, p[2] / 100);
    return [r, g, b, p.length > 3 ? p[3] : 1];
  }
  return null;
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = mod(t, 1); return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
const toCss = ([r, g, b, a]) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;

// 相対輝度とコントラスト比（WCAG 2.x の定義）
export function luminance([r, g, b]) {
  const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
export function contrast(a, b) {
  const la = luminance(typeof a === 'string' ? parseColor(a) : a), lb = luminance(typeof b === 'string' ? parseColor(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// 夜の地図の色：明るい面（背景・建物・水）は暗く、道は背景より少し明るく、文字は明るく・縁取りは暗く。色合い（色相）は残し、彩度は控えめに
// prop：MapLibre の塗りのプロパティ名
export function nightColor(s, prop) {
  const c = parseColor(s);
  if (!c) return s;
  const [h, sat, l] = rgbToHsl(c[0], c[1], c[2]);
  let L, S = sat * 0.55;
  if (prop === 'text-color') L = 0.92 - l * 0.6;
  else if (prop === 'text-halo-color' || prop === 'icon-halo-color') { L = 0.08; S = sat * 0.3; }
  else if (prop === 'line-color') L = 0.16 + l * 0.28;
  else L = 0.07 + (1 - l) * 0.35; // background・fill・fill-extrusion など
  const [r, g, b] = hslToRgb(h, Math.min(1, S), Math.max(0, Math.min(1, L)));
  return toCss([r, g, b, c[3]]);
}

// 式（["interpolate", …, "#fff", …] など）の中の色も変える
export function mapColors(v, prop, f = nightColor) {
  if (isColorString(v)) return f(v, prop);
  if (Array.isArray(v)) return v.map((x) => mapColors(x, prop, f));
  return v;
}
