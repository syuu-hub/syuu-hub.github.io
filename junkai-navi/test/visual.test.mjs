// TZ=Asia/Tokyo node test/visual.test.mjs — 見た目：昼・夜の切り替え、文字の大きさ・コントラスト、色覚の多様性への配慮
import { readFileSync } from 'node:fs';
import { sunTimes, isDark, nightColor, mapColors, parseColor, contrast, luminance } from '../js/theme.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };
const J = (s) => new Date(`${s}+09:00`);
const hm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const near = (d, h, m, tol = 4) => Math.abs(d.getHours() * 60 + d.getMinutes() - (h * 60 + m)) <= tol;

// ===== 日の出・日の入り（神戸 34.69N 135.19E。国立天文台の暦と数分以内） =====
const K = [34.69, 135.19];
for (const [day, r, s] of [['2026-06-21', [4, 47], [19, 15]], ['2026-12-22', [7, 2], [16, 52]], ['2026-11-28', [6, 45], [16, 48]]]) {
  const t = sunTimes(J(`${day}T12:00:00`), ...K);
  ok(near(t.sunrise, ...r) && near(t.sunset, ...s), `${day} 日の出 ${hm(t.sunrise)}・日の入り ${hm(t.sunset)}`);
}
ok(isDark(J('2026-11-28T17:30:00'), ...K) && !isDark(J('2026-11-28T12:00:00'), ...K) && isDark(J('2026-11-28T05:00:00'), ...K), '夜（日の入り〜日の出）だけ暗く');

// ===== 夜の地図の色 =====
const bg = parseColor(nightColor('#f8f4f0', 'background-color')), road = parseColor(nightColor('#ffffff', 'line-color'));
const text = parseColor(nightColor('#333333', 'text-color')), halo = parseColor(nightColor('#ffffff', 'text-halo-color'));
ok(luminance(bg) < 0.03, `背景は暗く（輝度 ${luminance(bg).toFixed(3)}）`);
ok(contrast(road, bg) >= 3, `道は背景より明るく見分けられる（コントラスト ${contrast(road, bg).toFixed(1)}:1、3:1以上）`);
ok(contrast(text, halo) >= 4.5, `地名の文字は読める（コントラスト ${contrast(text, halo).toFixed(1)}:1、4.5:1以上）`);
const expr = ['interpolate', ['linear'], ['zoom'], 5, '#ffffff', 12, 'hsl(0, 0%, 90%)'];
const ex2 = mapColors(expr, 'fill-color');
ok(ex2[0] === 'interpolate' && ex2[2][0] === 'zoom' && ex2[4] !== '#ffffff' && /^rgba/.test(ex2[6]), '式の中の色だけ変える（"zoom" などの文字は変えない）');
ok(parseColor(nightColor('rgba(255,255,255,0.4)', 'fill-color'))[3] === 0.4, '透明度はそのまま');

// ===== 画面の色：文字のコントラスト（WCAG 2.x：文字 4.5:1、大きな文字・図 3:1） =====
const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1], m[2]]));
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('/* カラー（ダーク）')));
const dark = { ...light, ...tokens(css.slice(css.indexOf(':root[data-theme="dark"] {'), css.indexOf('@media (prefers-color-scheme: dark)'))) };
for (const [name, T] of [['昼', light], ['夜', dark]]) {
  const pairs = [
    ['本文', 'on-surface', 'surface', 4.5], ['説明の文字', 'on-surface-variant', 'surface-low', 4.5], ['見出し', 'primary', 'surface-low', 4.5],
    ['主なボタン', 'on-primary', 'primary', 4.5], ['巡回中の印', 'on-primary-container', 'primary-container', 4.5],
    ['需要の印（●）', 'demand-text', 'surface-low', 4.5], ['順位の数字', 'surface-lowest', 'demand-text', 4.5],
  ];
  for (const [label, fg, bgk, min] of pairs) {
    const c = contrast(T[`md-${fg}`] || T[fg], T[`md-${bgk}`] || T[bgk]);
    ok(c >= min, `${name}：${label} ${c.toFixed(1)}:1（${min}:1以上）`);
  }
}
ok(contrast('#ffffff', '#0f5132') >= 7 && contrast('#ffffff', '#0a3b24') >= 7, `上の案内の白い文字 ${contrast('#ffffff', '#0f5132').toFixed(1)}:1（7:1以上。走行中に一瞬で読む）`);

// ===== 走行中に読む文字の大きさ（ISO 15008：視角おおよそ16分以上。スマホを50〜60cm先に置くと16px以上） =====
const fontOf = (sel) => { const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*font-size:\\s*(\\d+)px`).exec(css); return m ? +m[2] : null; };
for (const sel of ['.b-dist', '.b-street', '.b-then', '.s-target', '.sheet-row2', '.s-level', '.s-mode', '.sheet.collapsed .s-target']) {
  const f = fontOf(sel);
  ok(f >= 16, `${sel} ${f}px（16px以上）`);
}

// ===== 色覚の多様性：内訳の色が、P型・D型の色覚でも見分けられる（Viénot ほか 1999 の見え方の計算 × CIELAB の色差） =====
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const MAT = { normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], P: [[0.11238, 0.88762, 0], [0.11238, 0.88762, 0], [0.00401, -0.00401, 1]], D: [[0.29275, 0.70725, 0], [0.29275, 0.70725, 0], [-0.02234, 0.02234, 1]] };
const lab = (hex, type) => {
  const [r, g, b] = parseColor(hex).slice(0, 3).map(lin);
  const [R, G, B] = MAT[type].map((row) => Math.max(0, row[0] * r + row[1] * g + row[2] * b));
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const minDE = (cols, type) => {
  let m = Infinity;
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) { const a = lab(cols[i], type), b = lab(cols[j], type); m = Math.min(m, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); }
  return m;
};
const seg = (k) => { const m = new RegExp(`\\.cd-seg\\.${k}[^{]*\\{\\s*background:\\s*(#[0-9a-f]{6})`).exec(css); return m && m[1]; };
const now = [seg('ride'), seg('event'), seg('spot')], before = ['#e37400', '#b3261e', '#1b6b40'];
for (const type of ['normal', 'P', 'D']) {
  const a = minDE(now, type), b = minDE(before, type);
  ok(a >= 20 && a >= b, `${type === 'normal' ? '一般' : type + '型'}の色覚：内訳の色の差（CIELAB の色差）今 ${a.toFixed(0)}・以前 ${b.toFixed(0)}（20以上で見分けやすい）`);
}

console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
