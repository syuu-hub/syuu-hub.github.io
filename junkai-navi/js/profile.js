// 登録地点の「時間帯・曜日」のプロファイル
// prof = { h: [24], d: [7], src: 'log' | 'manual', n? }
//   log    … タクシーアナライザの営業ログの乗車時刻・曜日の回数（n＝乗車回数）
//   manual … 自分で指定した時間帯・曜日（1＝対象、0＝対象外）
// d は 0＝日曜 … 6＝土曜（Date#getDay と同じ）

import { isOffDay } from './calendar.js?v=24';

export const DAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
const isWeekend = (dow) => dow === 0 || dow === 6;

// その時刻の需要の倍率（0.05〜1）
export function profFactor(prof, date) {
  if (!prof || !Array.isArray(prof.h) || !Array.isArray(prof.d)) return 1;
  const hr = date.getHours(), dow = date.getDay();
  const H = (i) => prof.h[(i + 24) % 24] || 0;
  // 前後1時間も半分数える（10:50の乗車は11時台にも効く）
  const hs = (i) => H(i) + 0.5 * (H(i - 1) + H(i + 1));
  let maxH = 0;
  for (let i = 0; i < 24; i++) maxH = Math.max(maxH, hs(i));
  const hw = maxH > 0 ? hs(hr) / maxH : 1;
  const maxD = Math.max(...prof.d);
  let dw = 1;
  if (maxD > 0) {
    if (prof.src === 'manual') dw = prof.d[dow] ? 1 : 0;
    else {
      // 曜日そのものと、平日／休日（土日・祝日）の傾向を半分ずつ
      const avg = (we) => { const ds = [0, 1, 2, 3, 4, 5, 6].filter((x) => isWeekend(x) === we); return ds.reduce((s, x) => s + prof.d[x], 0) / ds.length; };
      const typeMax = Math.max(avg(true), avg(false)) || 1;
      dw = 0.5 * (prof.d[dow] / maxD) + 0.5 * (avg(isOffDay(date)) / typeMax); // 祝日は休日の傾向
    }
  }
  let f = hw * dw;
  // 営業ログの回数が少ないうちは、時間・曜日の偏りを弱める（1回だけの乗車で他の時間を0にしない）
  if (prof.src === 'log') { const c = (prof.n || 0) / ((prof.n || 0) + 3); f = (1 - c) * 0.5 + c * f; }
  return Math.max(0.05, Math.min(1, f));
}

// 時間帯のフラグ [24] → 「7-10時・18-24時」（終わりの時は含まない）
function rangesText(flags) {
  const out = [];
  let i = 0;
  while (i < 24) {
    if (!flags[i]) { i++; continue; }
    let j = i;
    while (j < 24 && flags[j]) j++;
    out.push([i, j]);
    i = j;
  }
  // 日をまたぐ（22-24時と0-2時）は 22-2時 にまとめる
  if (out.length > 1 && out[0][0] === 0 && out[out.length - 1][1] === 24) { const last = out.pop(); out[0] = [last[0], out[0][1]]; }
  return out.map(([a, b]) => `${a}-${b}時`).join('・');
}
function daysFlagsText(flags) {
  const on = [0, 1, 2, 3, 4, 5, 6].filter((x) => flags[x]);
  if (on.length === 7) return '毎日';
  if (on.length === 5 && on.every((x) => !isWeekend(x))) return '平日';
  if (on.length === 2 && on.every(isWeekend)) return '土日';
  return [1, 2, 3, 4, 5, 6, 0].filter((x) => flags[x]).map((x) => DAY_JA[x]).join('');
}

// 表示用：「多い時間」は回数が最大の半分以上の時間・曜日
export function hoursText(prof) {
  if (!prof) return '';
  const max = Math.max(...prof.h);
  if (!(max > 0)) return '';
  const flags = prof.h.map((v) => (prof.src === 'manual' ? v > 0 : v >= max * 0.5));
  return flags.every(Boolean) ? '' : rangesText(flags);
}
export function daysText(prof) {
  if (!prof) return '';
  const max = Math.max(...prof.d);
  if (!(max > 0)) return '';
  const flags = prof.d.map((v) => (prof.src === 'manual' ? v > 0 : v >= max * 0.5));
  const t = daysFlagsText(flags);
  return t === '毎日' ? '' : t;
}
export function profText(prof) {
  const h = hoursText(prof), d = daysText(prof);
  if (!h && !d) return '';
  return (prof.src === 'log' ? '乗車が多い：' : '') + [h, d].filter(Boolean).join(' / ');
}

// 「7-10, 18-2」→ 時間帯のフラグ [24]。空なら null
export function parseHours(text) {
  const t = String(text || '').replace(/[時\s]/g, '').replace(/[〜～~－ー]/g, '-').replace(/[、・／/]/g, ',');
  if (!t) return null;
  const flags = Array(24).fill(0);
  for (const part of t.split(',')) {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(part);
    if (!m) continue;
    const a = +m[1] % 24, end = +m[2] % 24; // 終わりの時は含まない。24時は0時と同じ
    if (a === end) { flags.fill(1); continue; }
    for (let h = a; h !== end; h = (h + 1) % 24) flags[h] = 1;
  }
  return flags.some(Boolean) ? flags : null;
}
// 「平日」「土日」「毎日」「月水金」→ 曜日のフラグ [7]。空なら null
export function parseDays(text) {
  const t = String(text || '').trim();
  if (!t || t === '毎日') return null;
  const flags = Array(7).fill(0);
  if (/平日/.test(t)) [1, 2, 3, 4, 5].forEach((x) => (flags[x] = 1));
  if (/土日|休日|週末/.test(t)) [0, 6].forEach((x) => (flags[x] = 1));
  DAY_JA.forEach((c, i) => { if (t.replace(/土日|平日/g, '').includes(c)) flags[i] = 1; });
  return flags.some(Boolean) ? flags : null;
}
// 自分で指定した時間帯・曜日 → プロファイル（どちらも指定なしなら null）
export function manualProf(hours, days) {
  if (!hours && !days) return null;
  return { h: hours || Array(24).fill(1), d: days || Array(7).fill(1), src: 'manual' };
}
// 営業ログの乗車時刻（ミリ秒）の一覧 → プロファイル
export function logProf(times) {
  const h = Array(24).fill(0), d = Array(7).fill(0);
  for (const t of times) { const x = new Date(t); h[x.getHours()]++; d[x.getDay()]++; }
  return { h, d, src: 'log', n: times.length };
}
