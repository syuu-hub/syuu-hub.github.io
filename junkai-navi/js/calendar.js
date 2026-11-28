// 日本の祝日・休日（需要は土日と同じ傾向になるので、平日／休日の区別に使う）
// 祝日法の決まり（固定日・ハッピーマンデー・春分／秋分・振替休日・国民の休日）から計算する。年末年始（12/30〜1/3）も休日扱い

const nthMonday = (y, m, n) => { const first = new Date(y, m - 1, 1).getDay(); return 1 + ((8 - first) % 7) + (n - 1) * 7; };
const vernal = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnal = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// その日そのものが祝日か（振替休日・国民の休日は含まない）
function baseHoliday(y, m, d) {
  const md = m * 100 + d;
  if ([101, 211, 223, 429, 503, 504, 505, 811, 1103, 1123].includes(md)) return true;
  if (m === 1 && d === nthMonday(y, 1, 2)) return true; // 成人の日
  if (m === 7 && d === nthMonday(y, 7, 3)) return true; // 海の日
  if (m === 9 && d === nthMonday(y, 9, 3)) return true; // 敬老の日
  if (m === 10 && d === nthMonday(y, 10, 2)) return true; // スポーツの日
  if (m === 3 && d === vernal(y)) return true;
  if (m === 9 && d === autumnal(y)) return true;
  return false;
}

const cache = new Map();
export function isHoliday(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  const key = y * 10000 + m * 100 + d;
  if (cache.has(key)) return cache.get(key);
  const on = (dd) => { const x = new Date(y, m - 1, d + dd); return baseHoliday(x.getFullYear(), x.getMonth() + 1, x.getDate()); };
  let h = on(0);
  // 振替休日：日曜の祝日の後、最初の祝日でない日
  if (!h && date.getDay() !== 0) for (let k = 1; k <= 7; k++) { if (!on(-k)) break; if (new Date(y, m - 1, d - k).getDay() === 0) { h = true; break; } }
  // 国民の休日：祝日に挟まれた日
  if (!h && date.getDay() !== 0 && on(-1) && on(1)) h = true;
  if (cache.size > 400) cache.clear();
  cache.set(key, h);
  return h;
}

// 休日（土日・祝日・年末年始）か
export function isOffDay(date) {
  const dow = date.getDay(), m = date.getMonth() + 1, d = date.getDate();
  if (dow === 0 || dow === 6) return true;
  if ((m === 12 && d >= 30) || (m === 1 && d <= 3)) return true;
  return isHoliday(date);
}

// ===== 人の暮らしのリズム（社会の暦）=====
// 夜の需要は「営業日」でまとめる：0〜4時台は前の日の夜の続き
export const serviceDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getHours() < 5 ? 1 : 0));
export const isNight = (d) => d.getHours() >= 18 || d.getHours() < 3;
const nextDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

// 休みの前の夜（金曜の夜・祝日の前の夜。いわゆる花金）：今日は平日で、次の日が休日の 18時〜翌3時
// 翌日を気にせず遅くまで出かけるので、飲食・繁華街の夜の需要が増える
export function isPreOffNight(d) {
  const s = serviceDay(d);
  return isNight(d) && !isOffDay(s) && isOffDay(nextDay(s));
}

// 給料日：25日（土日祝なら前の平日）。日本で一般的な支給日
export function payday(y, m) {
  let d = new Date(y, m, 25);
  while (isOffDay(d)) d = new Date(y, m, d.getDate() - 1);
  return d;
}

// 社会の暦で夜の需要が増える時期（夜だけ）。mult は、夜に乗せることが多いエリアへの倍率（理論からの初期値）
//   給料日から3日間の夜：収入が入ると支出（外食・娯楽）が増える（Stephens 2003、Gelman ほか 2014）
//   忘年会（12/1〜12/28の夜）・新年会（1/6〜1/25の夜）：年末年始の宴会の慣習
export function socialCalendar(d) {
  if (!isNight(d)) return null;
  const s = serviceDay(d), m = s.getMonth() + 1, day = s.getDate();
  const out = [];
  if (m === 12 && day <= 28) out.push({ key: 'bonen', label: '忘年会シーズンの夜', mult: 1.2 });
  if (m === 1 && day >= 6 && day <= 25) out.push({ key: 'shinnen', label: '新年会シーズンの夜', mult: 1.1 });
  const pd = payday(s.getFullYear(), s.getMonth());
  const diff = Math.round((s - pd) / 864e5);
  if (diff >= 0 && diff <= 3) out.push({ key: 'payday', label: '給料日のあとの夜', mult: 1.15 });
  if (!out.length) return null;
  out.sort((a, b) => b.mult - a.mult);
  return { key: out.map((x) => x.key).join('+'), label: out.map((x) => x.label).join('・'), mult: out[0] ? Math.min(1.35, out.reduce((p, x) => p * x.mult, 1)) : 1 };
}
