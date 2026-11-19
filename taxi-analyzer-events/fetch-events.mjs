// 神戸の主要会場のイベント情報を集めて taxi-analyzer/events.json に書き出す（GitHub Actions で毎日1回実行）
//   各会場の公式サイトの公開ページを、1日1回・会場ごとに数ページだけ読む
//   終演（終了）時刻は公表されていないので、開演＋会場・種類ごとのおおよその長さで推定する
//   node taxi-analyzer-events/fetch-events.mjs [--local dir]   … --local は保存したページで試す時用
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'taxi-analyzer/events.json');
const localDir = process.argv.includes('--local') ? process.argv[process.argv.indexOf('--local') + 1] : null;
const UA = 'Mozilla/5.0 (compatible; taxi-analyzer-events/1.0; +https://syuu-hub.github.io/taxi-analyzer/)';

// 日本時間の今日
const jstNow = new Date(Date.now() + 9 * 3600e3);
const TODAY = jstNow.toISOString().slice(0, 10);
const Y = jstNow.getUTCFullYear(), M = jstNow.getUTCMonth() + 1;
const ym = k => { const d = new Date(Date.UTC(Y, M - 1 + k, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// 月・日だけの日付に年を付ける（今日より大きく前なら翌年）
const withYear = (m, d) => { let y = Y; if (ymd(y, m, d) < ymd(Y, M, 1) && m < M - 6) y++; return ymd(y, m, d); };
const addMin = (hm, min) => { if (!hm) return null; const [h, mi] = hm.split(':').map(Number), t = h * 60 + mi + min; return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; };
const hm = s => { const m = /(\d{1,2})[:：](\d{2})/.exec(s || ''); return m ? `${pad(+m[1])}:${m[2]}` : null; };
const clean = s => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

let localMap = {};
if (localDir) try { localMap = JSON.parse(readFileSync(join(localDir, '_map.json'), 'utf8')); } catch (e) {}
async function get(url) {
  if (localDir) { const f = localMap[url]; return f && existsSync(join(localDir, f)) ? readFileSync(join(localDir, f), 'utf8') : ''; }
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await new Promise(ok => setTimeout(ok, 800));   // 相手のサーバーに負担をかけないよう間をあける
  return r.text();
}

// ── 会場（収容人数はおおよそ。dur は開演から終演までのおおよその分）
const V = {
  world: { venue: 'ワールド記念ホール', cap: 8000, dur: 150 },
  kih: { venue: '神戸国際会館こくさいホール', cap: 2000, dur: 150 },
  bunkaL: { venue: '神戸文化ホール 大ホール', cap: 2000, dur: 150 },
  bunkaM: { venue: '神戸文化ホール 中ホール', cap: 900, dur: 150 },
  kccEx: { venue: '神戸国際展示場', cap: 5000 },
  kccCv: { venue: '神戸国際会議場', cap: 3000 },
  noesta: { venue: 'ノエビアスタジアム神戸', cap: 30000, dur: 120 },
  glion: { venue: 'GLION ARENA KOBE', cap: 10000, dur: 120 },
};
const ev = (v, date, start, title, extra = {}) => ({ date, start: start || null, end: start ? addMin(start, V[v].dur || 150) : extra.end || null, venue: V[v].venue, cap: V[v].cap, title, ...extra });

// ワールド記念ホール：月ごとのイベントカレンダー（イベントごとに「月日(曜) 開演～」が並ぶ）
async function world() {
  const out = [];
  for (const k of [0, 1, 2]) {
    const { y, m } = ym(k), html = await get(`https://www.kobe-spokyo.jp/world-kobe/cal_event?ym=${y}${pad(m)}`);
    for (const li of html.split(/<li\b[^>]*>/).slice(1)) {
      const title = clean((/^\s*<span>([\s\S]*?)<\/span>/.exec(li) || [])[1]);
      if (!title) continue;
      const re = /(\d{1,2})月(\d{1,2})日[^<]*<\/span>\s*(?:<span>(?:<span>)*(?:<span[^>]*>)?(\d{1,2}:\d{2}))?/g;
      for (let x; (x = re.exec(li));) out.push(ev('world', withYear(+x[1], +x[2]), x[3] ? hm(x[3]) : null, title));
    }
  }
  return out;
}

// 神戸国際会館こくさいホール：月の一覧（公演名・公演日）→ 近い公演は詳細ページで開演時刻
async function kih() {
  const list = new Map();
  for (const k of [0, 1]) {
    const { y, m } = ym(k), html = await get(`https://www.kih.co.jp/kokusaihall/event/index/${y}-${pad(m)}-01`);
    for (const li of html.split(/<li\b[^>]*>/).slice(1)) {
      const t = /<p class="title"><a href="(\/kokusaihall\/event\/detail\/\d+)">([\s\S]*?)<\/a>/.exec(li);
      const d = /<p class="day">[\s\S]*?(\d{4})年(\d{2})月(\d{2})日[^<～]*(?:<br\s*\/?>\s*)?(?:～(\d{4})年(\d{2})月(\d{2})日)?/.exec(li);
      if (!t || !d || /PRIVATE/i.test(t[2])) continue;
      list.set(t[1], { url: t[1], title: clean(t[2]), from: ymd(+d[1], +d[2], +d[3]), to: d[4] ? ymd(+d[4], +d[5], +d[6]) : ymd(+d[1], +d[2], +d[3]) });
    }
  }
  const out = [], soon = ymd(...Object.values(ym(1)), 28);
  for (const e of list.values()) {
    if (e.to < TODAY) continue;
    let times = [];
    if (e.from <= soon) {   // 近い公演だけ詳細を読む
      try {
        const html = await get('https://www.kih.co.jp' + e.url);
        const raw = (/<th>日時<\/th>\s*<td>([\s\S]*?)<\/td>/.exec(html) || [])[1] || '';
        times = timesFrom(raw.split(/<br\s*\/?>/i).map(clean), e.from, e.to);
      } catch (err) { console.warn('kih detail', err.message); }
    }
    if (!times.length) for (let d = e.from; d <= e.to; d = next(d)) times.push([d, null]);
    for (const [d, t] of times) out.push(ev('kih', d, t, e.title));
  }
  return out;
}
const next = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
// 「日時」の行から [日付, 開演] を取り出す。書き方は会場・公演ごとに違う：
//   「2026年11月19日(木) OPEN/18:00 START/19:00」「2026/11/22(日) OPEN 16:30 / START 17:30」「2026/11/29(日) 16:30」
//   「…18:30開演（17:30開場）」「2026年11月3日（火祝）開場 17:00 / 開演 18:00」（2日目以降は年が省かれることがある）
function timesFrom(lines, from, to) {
  const times = [];
  let yy = +from.slice(0, 4), lastDate = null;
  for (const line of lines.filter(Boolean)) {
    const dm = /(?:(\d{4})[年\/.])?(\d{1,2})[月\/.](\d{1,2})日?/.exec(line);
    if (dm) { if (dm[1]) yy = +dm[1]; lastDate = ymd(yy, +dm[2], +dm[3]); }
    const rest = dm ? line.slice(dm.index + dm[0].length) : line;
    const st = /(\d{1,2}[:：]\d{2})\s*開演/.exec(rest) || /(?:開演|START)\s*[\/／:：]?\s*(\d{1,2}[:：]\d{2})/i.exec(rest);
    const all = [...rest.matchAll(/(\d{1,2}[:：]\d{2})/g)].map(x => x[1]);
    const op = /(\d{1,2}[:：]\d{2})\s*開場/.exec(rest) || /(?:開場|OPEN)\s*[\/／:：]?\s*(\d{1,2}[:：]\d{2})/i.exec(rest);
    const tm = st ? st[1] : all.filter(x => !op || x !== op[1]).pop();
    if (lastDate && tm) times.push([lastDate, hm(tm)]);
  }
  // 日付の無い「18:30開演」だけの時は、公演日すべてに
  if (!times.length) { const t1 = /(\d{1,2}[:：]\d{2})\s*開演/.exec(lines.join(' ')); if (t1) for (let d = from; d <= to; d = next(d)) times.push([d, hm(t1[1])]); }
  return times;
}

// 神戸文化ホール：公演カレンダー（日程・ホール・開演（開場）・公演名）
async function bunka() {
  const out = [];
  for (const k of [0, 1]) {
    const { y, m } = ym(k), html = await get(`https://www.kobe-bunka.jp/hall/date/${y}/${pad(m)}/?cat=2`);
    for (const tr of html.split(/<tr\b[^>]*>/).slice(1)) {
      const d = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(tr), hall = /(大ホール|中ホール)<\/a>/.exec(tr);
      const tds = tr.split(/<td\b[^>]*>/);
      if (!d || !hall || tds.length < 4) continue;
      const start = hm(clean(tds[2]).replace(/^開演（開場）：/, ''));
      const title = clean((/<div class="event-right">([\s\S]*?)<\/div>/.exec(tds[3]) || [, tds[3]])[1]);
      if (!title || /お知らせ|抽選/.test(title)) continue;
      out.push(ev(hall[1] === '大ホール' ? 'bunkaL' : 'bunkaM', ymd(+d[1], +d[2], +d[3]), start, title));
    }
  }
  return out;
}

// 神戸コンベンションセンター（国際展示場・国際会議場）：催事の期間（時刻は無し。日中の催し）
async function kcc() {
  const out = [];
  for (const k of [0, 1]) {
    const { y, m } = ym(k), html = await get(`https://kobe-cc.jp/ja/visitors/upcoming-events/?ey=${y}&em=${pad(m)}`);
    for (const tr of html.split(/<tr\b[^>]*>/).slice(1)) {
      const ds = [...tr.matchAll(/<span>(\d{4})\.(\d{2})\.(\d{2})\d?<\/span>/g)];
      const tds = tr.split(/<td\b[^>]*>/);
      if (ds.length < 1 || tds.length < 5) continue;
      const title = clean(tds[2]), place = clean(tds[4]);
      const v = /展示場/.test(place) ? 'kccEx' : 'kccCv';
      const from = ymd(+ds[0][1], +ds[0][2], +ds[0][3]), to = ds[1] ? ymd(+ds[1][1], +ds[1][2], +ds[1][3]) : from;
      for (let d = from; d <= to; d = next(d)) out.push(ev(v, d, null, title, { end: '17:00', day: true }));
    }
  }
  return out;
}

// ヴィッセル神戸：Jリーグ公式のクラブ日程（ページ内のデータ）。ノエスタ（御崎公園）の試合だけ
async function vissel() {
  const html = (await get('https://www.jleague.jp/club/kobe/day/')).replace(/\\"/g, '"');
  const out = [], seen = new Set();
  const starts = [...html.matchAll(/"matchDate":"\$D(\d{4}-\d{2}-\d{2})/g)];
  starts.forEach((s, i) => {
    const seg = html.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : s.index + 6000);
    for (const m of seg.matchAll(/"stadiumFullName":"([^"]*)"[\s\S]*?"time":"(\d{1,2}:\d{2})"[\s\S]*?"homeTeam":\{[^{}]*?"name":"([^"]*)"[\s\S]*?"awayTeam":\{[^{}]*?"name":"([^"]*)"/g)) {
      if (!/ノエビア|御崎/.test(m[1])) continue;
      const k = s[1] + m[2];
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ev('noesta', s[1], hm(m[2]), `ヴィッセル神戸 vs ${m[4] === '神戸' ? m[3] : m[4]}`, { sport: true }));
    }
  });
  return out;
}

// 神戸ストークス：ホームゲーム（GLION ARENA KOBE）
async function storks() {
  const html = await get('https://www.storks.jp/schedule/list/');
  const out = [], t = clean(html);
  for (const x of t.matchAll(/HOME\s+\S+\s+神戸\s+(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}:\d{2})\s*location_on\s*GLION ARENA KOBE\s*(\S+)/g)) {
    out.push(ev('glion', withYear(+x[1], +x[2]), hm(x[3]), `神戸ストークス vs ${x[4]}`, { sport: true }));
  }
  return out;
}

// GLION ARENA KOBE：イベント一覧は画面の中で組み立てる作りなので、ブラウザ（Playwright）で表示して読む（今月・来月）
//   アリーナでの催し（ARENA）だけ。ストークスの試合は storks() で取るので除く。開演は詳細ページ（普通に読める）から
async function glion() {
  if (localDir) return [];
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  const items = new Map();
  try {
    const p = await b.newPage({ locale: 'ja-JP', userAgent: UA });
    await p.goto('https://www.totteikobe.jp/event', { waitUntil: 'networkidle', timeout: 60000 });
    const read = () => p.$$eval('.EventMonthly-content-day', days => days.flatMap(d => {
      const date = (d.querySelector('.EventListHeader-date') || {}).textContent || '';
      return [...d.querySelectorAll('.EventListCard')].map(c => ({ date: date.trim(),
        cat: (c.querySelector('.EventListCard-category') || {}).textContent?.trim(), label: (c.querySelector('.EventListCard-label') || {}).textContent?.trim(),
        href: (c.querySelector('a[href*="/event/article/"]') || {}).getAttribute?.('href'), title: (c.querySelector('.EventListCard-title') || {}).textContent?.trim() }));
    }));
    const add = list => { for (const x of list) if (x.href && x.label === 'ARENA' && x.cat !== 'STORKS') { const k = x.href + x.date; if (!items.has(k)) items.set(k, x); } };   // 複数日の催しは日ごとに
    add(await read());
    const nm = ym(1).m, mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][nm - 1];
    try { await p.getByText(mon, { exact: true }).first().click(); await p.waitForTimeout(4000); add(await read()); } catch (e) { console.warn('glion next month', e.message); }
  } finally { await b.close(); }
  const out = [];
  for (const x of items.values()) {
    const m = /^(\d{1,2})\.(\d{1,2})/.exec(x.date); if (!m) continue;
    const day = withYear(+m[1], +m[2]);
    let times = [];
    try {
      const t = clean(await get('https://www.totteikobe.jp' + x.href));
      const cell = (/時間\s*([\s\S]*?)(?:URL|主催者|料金|チケット|お問い合わせ|お気に入り)/.exec(t) || [])[1] || '';
      // 「2026年11月3日（火祝）開場 17:00 / 開演 18:00 2026年11月4日（水）開場 …」を日ごとに分ける
      times = timesFrom(cell.split(/(?=\d{4}年\d{1,2}月\d{1,2}日)/), day, day);
    } catch (e) { console.warn('glion detail', e.message); }
    const hit = times.find(([d]) => d === day);
    out.push(ev('glion', day, hit ? hit[1] : null, x.title, x.cat === 'SPORTS' ? { sport: true } : {}));
  }
  return out;
}

const SOURCES = { world, kih, bunka, kcc, vissel, storks, glion };
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { events: [] };
const all = [], status = {};
for (const [k, fn] of Object.entries(SOURCES)) {
  try { const r = await fn(); r.forEach(e => { e.src = k; }); all.push(...r); status[k] = r.length; }
  catch (e) {
    // 読めなかった会場は前回の分を残す（会場名で見分ける）
    status[k] = 'error: ' + e.message;
    console.warn(k, e.message);
  }
}
const keep = (prev.events || []).filter(e => e.src && typeof status[e.src] !== 'number');   // 読めなかった取得元は前回の分
const limit = ymd(...Object.values(ym(2)), 31);
const events = [...all, ...keep]
  .filter(e => e.date >= TODAY && e.date <= limit)
  .sort((a, b) => (a.date + (a.start || '99')).localeCompare(b.date + (b.start || '99')));
// 同じ会場・日・時刻・名前の重複を消す
const uniq = [...new Map(events.map(e => [e.date + e.venue + e.start + e.title, e])).values()];
writeFileSync(OUT, JSON.stringify({ updated: TODAY, status, events: uniq }, null, 1) + '\n');   // 日付だけ（同じ日に何度動かしても、内容が同じなら変わらない）
console.log(JSON.stringify(status), uniq.length, 'events');
