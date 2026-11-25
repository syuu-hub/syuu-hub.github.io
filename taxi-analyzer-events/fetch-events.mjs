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
  koshien: { venue: '阪神甲子園球場', cap: 40000, dur: 210 },
  hotto: { venue: 'ほっともっとフィールド神戸', cap: 30000, dur: 210 },
  portT: { venue: '神戸ポートターミナル', cap: 2000 },
  nakaT: { venue: '中突堤旅客ターミナル', cap: 1000 },
};
const cut = (s, n = 100) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const absUrl = (u, base) => { try { return u ? new URL(u.replace(/&amp;/g, '&'), base).href : undefined; } catch (e) { return undefined; } };
// 詳細：空の項目は持たない
// 料金：「※…」「【…」以降の注意書きは除く
const priceOf = s => { const c = clean(s), p = c.replace(/\s*[※【][\s\S]*$/, ''); return cut(p || c); };
const goodsOf = text => { const m = /[^。\s]{0,20}グッズ[^。]{0,90}/.exec(clean(text)); return m ? cut(m[0], 110) : undefined; };
const info = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
const ev = (v, date, start, title, extra = {}) => ({ date, start: start || null, end: start ? addMin(start, V[v].dur || 150) : extra.end || null, venue: V[v].venue, cap: V[v].cap, title, ...extra });

// ワールド記念ホール：月ごとのイベントカレンダー（イベントごとに「月日(曜) 開演～」が並ぶ）
async function world() {
  const out = [];
  for (const k of [0, 1, 2]) {
    const { y, m } = ym(k), html = await get(`https://www.kobe-spokyo.jp/world-kobe/cal_event?ym=${y}${pad(m)}`);
    for (const li of html.split(/<li\b[^>]*>/).slice(1)) {
      const title = clean((/^\s*<span>([\s\S]*?)<\/span>/.exec(li) || [])[1]);
      if (!title) continue;
      // お問い合わせ（主催の名前・電話）と、アーティストの公式サイト
      const contactHtml = (/<\/span><\/span>\s*<span>((?:(?!<\/span>\s*<span>)[\s\S])*?<span>[\d-]+<\/span>)<\/span>/.exec(li) || [])[1] || '';
      const links = [...li.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const artist = links.find(l => /ｱｰﾃｨｽﾄ|アーティスト|オフィシャル|公式/.test(l[2]));
      const det = info({ contact: cut(contactHtml), url: absUrl((artist || links[0] || [])[1], 'https://www.kobe-spokyo.jp/') });
      const re = /(\d{1,2})月(\d{1,2})日[^<]*<\/span>\s*(?:<span>(?:<span>)*(?:<span[^>]*>)?(\d{1,2}:\d{2}))?/g;
      for (let x; (x = re.exec(li));) out.push(ev('world', withYear(+x[1], +x[2]), x[3] ? hm(x[3]) : null, title, det));
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
    let times = [], det = { url: 'https://www.kih.co.jp' + e.url };
    if (e.from <= soon) {   // 近い公演だけ詳細を読む
      try {
        const html = await get('https://www.kih.co.jp' + e.url);
        const row = k => (new RegExp(`<th>${k}<\\/th>\\s*<td>([\\s\\S]*?)<\\/td>`).exec(html) || [])[1] || '';
        times = timesFrom(row('日時').split(/<br\s*\/?>/i).map(clean), e.from, e.to);
        det = info({ ...det, performer: cut(row('出演者') || row('アーティスト名'), 80), price: priceOf(row('入場料')), contact: cut(row('お問い合わせ')), goods: goodsOf(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')) });
      } catch (err) { console.warn('kih detail', err.message); }
    }
    if (!times.length) for (let d = e.from; d <= e.to; d = next(d)) times.push([d, null, null]);
    for (const [d, t, o] of times) out.push(ev('kih', d, t, e.title, info({ ...det, open: o })));
  }
  return out;
}
const next = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
// 「日時」の行から [日付, 開演, 開場] を取り出す。書き方は会場・公演ごとに違う：
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
    if (lastDate && tm) times.push([lastDate, hm(tm), op && op[1] !== tm ? hm(op[1]) : null]);
  }
  // 日付の無い「18:30開演」だけの時は、公演日すべてに
  if (!times.length) { const j = lines.join(' '), t1 = /(\d{1,2}[:：]\d{2})\s*開演/.exec(j), o1 = /(\d{1,2}[:：]\d{2})\s*開場/.exec(j); if (t1) for (let d = from; d <= to; d = next(d)) times.push([d, hm(t1[1]), o1 ? hm(o1[1]) : null]); }
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
      const tt = clean(tds[2]).replace(/^開演（開場）：/, ''), start = hm(tt), open = hm((/\((\d{1,2}[:：]\d{2})\)/.exec(tt) || [])[1]);
      const right = (/<div class="event-right">([\s\S]*?)<\/div>/.exec(tds[3]) || [, tds[3]])[1], title = clean(right);
      if (!title || /お知らせ|抽選/.test(title)) continue;
      const det = info({ open, price: priceOf((tds[4] || '').replace(/入場料：/, '')), contact: cut((tds[5] || '').replace(/お問い合わせ：/, '')), url: absUrl((/href="([^"]+)"/.exec(right) || [])[1], 'https://www.kobe-bunka.jp/') });
      out.push(ev(hall[1] === '大ホール' ? 'bunkaL' : 'bunkaM', ymd(+d[1], +d[2], +d[3]), start, title, det));
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
      const det = info({ contact: cut(tds[3], 80), url: absUrl((/href="([^"]+)"/.exec(tds[2]) || [])[1], 'https://kobe-cc.jp/') });
      for (let d = from; d <= to; d = next(d)) out.push(ev(v, d, null, title, { end: '17:00', day: true, ...det }));
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
    for (const m of seg.matchAll(/"detailHref":"([^"]*)","stadiumName":"[^"]*","stadiumFullName":"([^"]*)"[\s\S]*?"time":"(\d{1,2}:\d{2})"[\s\S]*?"homeTeam":\{[^{}]*?"name":"([^"]*)"[\s\S]*?"awayTeam":\{[^{}]*?"name":"([^"]*)"/g)) {
      const [, href, stadium, time, home, away] = m;
      // 大会名・節：この試合より前で一番近いもの
      const before = html.slice(Math.max(0, s.index - 600), s.index) + seg.slice(0, m.index), last = (k) => { const a = [...before.matchAll(new RegExp(`"${k}":"([^"]*)"`, 'g'))]; return a.length ? a[a.length - 1][1] : ''; };
      const league = last('leagueDisplayName'), sec = last('seasonText');
      if (!/ノエビア|御崎/.test(stadium)) continue;
      const k = s[1] + time;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ev('noesta', s[1], hm(time), `ヴィッセル神戸 vs ${away === '神戸' ? home : away}`, info({ sport: true, performer: [league, sec].filter(Boolean).join(' '), url: absUrl(href, 'https://www.jleague.jp/') })));
    }
  });
  return out;
}

// 神戸ストークス：ホームゲーム（GLION ARENA KOBE）
async function storks() {
  const html = await get('https://www.storks.jp/schedule/list/');
  const out = [], t = clean(html);
  for (const x of t.matchAll(/HOME\s+\S+\s+神戸\s+(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}:\d{2})\s*location_on\s*GLION ARENA KOBE\s*(\S+)/g)) {
    out.push(ev('glion', withYear(+x[1], +x[2]), hm(x[3]), `神戸ストークス vs ${x[4]}`, { sport: true, performer: 'B.LEAGUE', url: 'https://www.storks.jp/schedule/list/' }));
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
    let times = [], det = { url: 'https://www.totteikobe.jp' + x.href };
    try {
      const html = await get('https://www.totteikobe.jp' + x.href), t = clean(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' '));
      const cell = (/時間\s*([\s\S]*?)(?:URL|主催者|料金|チケット|お問い合わせ|お気に入り)/.exec(t) || [])[1] || '';
      // 「2026年11月3日（火祝）開場 17:00 / 開演 18:00 2026年11月4日（水）開場 …」を日ごとに分ける
      times = timesFrom(cell.split(/(?=\d{4}年\d{1,2}月\d{1,2}日)/), day, day);
      // 出演者・お問い合わせ・公式サイト（会場自身や SNS のリンクは除く）
      const urlSec = (/>\s*URL\s*<([\s\S]*?)(?:主催者|お問い合わせ|お気に入り)/.exec(html) || [])[1] || '';
      const official = [...urlSec.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).find(u => !/totteikobe/.test(u))
        || (/https?:\/\/[^\s<"）)]+/.exec(clean(urlSec)) || [])[0];
      det = info({ ...det, performer: cut((/出演者\s*([\s\S]*?)\s*(?:開催日|時間)/.exec(t) || [])[1], 80),
        contact: cut((/お問い合わせ\s*(?:お問い合わせ)?[：:]?\s*([\s\S]*?)\s*(?:お気に入り|共有|PICK UP)/.exec(t) || [])[1]), official: absUrl(official), goods: goodsOf(t) });
    } catch (e) { console.warn('glion detail', e.message); }
    const hit = times.find(([d]) => d === day);
    const e = ev('glion', day, hit ? hit[1] : null, x.title, info({ ...det, open: hit && hit[2], sport: x.cat === 'SPORTS' }));
    if (x.cat !== 'SPORTS' && e.start) e.end = addMin(e.start, 150);   // コンサートなどは試合より長め
    out.push(e);
  }
  return out;
}

// プロ野球：NPB 公式の月ごとの日程詳細から、甲子園・ほっともっとフィールド神戸の試合（今月・来月）
async function npb() {
  const out = [];
  for (const k of [0, 1]) {
    const { y, m } = ym(k);
    let html = '';
    try { html = await get(`https://npb.jp/games/${y}/schedule_${pad(m)}_detail.html`); } catch (e) { continue; }   // 日程が未発表の月は無い
    let date = null;
    for (const tr of html.split(/<tr\b/).slice(1)) {
      const d = /<th[^>]*>\s*(\d{1,2})\/(\d{1,2})/.exec(tr);
      if (d) date = ymd(y, +d[1], +d[2]);
      const place = clean((/<div class="place">([\s\S]*?)<\/div>/.exec(tr) || [])[1]).replace(/\s/g, '');
      const v = /甲子園/.test(place) ? 'koshien' : /ほっと神戸|ほっともっと/.test(place) ? 'hotto' : null;
      if (!date || !v) continue;
      const t1 = clean((/<div class="team1">([\s\S]*?)<\/div>/.exec(tr) || [])[1]), t2 = clean((/<div class="team2">([\s\S]*?)<\/div>/.exec(tr) || [])[1]);
      const time = hm(clean((/<div class="time">([\s\S]*?)<\/div>/.exec(tr) || [])[1]));
      const href = (/<a href="(\/scores\/[^"]+)"/.exec(tr) || [])[1];
      out.push(ev(v, date, time, `${t1} vs ${t2}`, info({ sport: true, performer: 'プロ野球', url: absUrl(href, 'https://npb.jp/') })));
    }
  }
  return out;
}

// 客船：神戸観光局の「客船入港予定」（今月・来月の表）。入港〜出港の時刻
async function ships() {
  const html = await get('https://www.kobe-meriken.or.jp/terminal/eta/');
  const out = [];
  for (const tr of html.split(/<tr\b[^>]*>/).slice(1)) {
    const td = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x => clean(x[1]));
    if (td.length < 9) continue;
    const [name, tons, berth, inD, inT, outD, outT, from, to] = td;
    const a = /(\d{1,2})月(\d{1,2})日/.exec(inD), b = /(\d{1,2})月(\d{1,2})日/.exec(outD);
    if (!a) continue;
    const day = withYear(+a[1], +a[2]), outDay = b ? withYear(+b[1], +b[2]) : day;
    const v = /NAKA/i.test(berth) ? 'nakaT' : 'portT';
    const ton = +tons.replace(/[^\d]/g, '') || 0;
    const e = ev(v, day, hm(inT), `客船 ${name.replace(/^\*/, '')}${name.startsWith('*') ? '（初入港）' : ''}`,
      info({ ship: true, depart: hm(outT), departDate: outDay !== day ? outDay : undefined, from, to, tons: ton || undefined, url: 'https://www.kobe-meriken.or.jp/terminal/eta/' }));
    e.end = outDay === day ? hm(outT) : null;   // 入港中（同じ日に出港する時はその時刻まで）
    if (ton) e.cap = Math.round(ton / 25 / 100) * 100;   // 乗客数のおおよそ（総トン数から）
    out.push(e);
  }
  return out;
}

const SOURCES = { world, kih, bunka, kcc, vissel, storks, glion, npb, ships };
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

// ── 過去のイベントを残す（taxi-analyzer/events-history.json）
//   events.json は今日以降だけなので、終わったイベントの日時・会場をここに残す。
//   巡回ナビが、営業ログの「会場まで乗せた乗車」が開演の何分前だったかを調べるのに使う（2年分）
const HIST = join(root, 'taxi-analyzer/events-history.json');
const hist = existsSync(HIST) ? JSON.parse(readFileSync(HIST, 'utf8')).events || [] : [];
const since = new Date(jstNow.getTime() - 730 * 864e5).toISOString().slice(0, 10);
const slim = e => info({ date: e.date, start: e.start || null, open: e.open, venue: e.venue, cap: e.cap, title: e.title, src: e.src });
// 同じ日・会場・名前は1件に（開演時刻がわかる方を残す）
const hmap = new Map();
for (const e of [...hist, ...(prev.events || []), ...uniq]) {
  if (!e.date || e.date > TODAY || e.date < since) continue;
  const k = e.date + '|' + e.venue + '|' + e.title, o = hmap.get(k);
  if (!o || (!o.start && e.start)) hmap.set(k, slim(e));
}
const hevents = [...hmap.values()].sort((a, b) => (a.date + (a.start || '99') + a.venue).localeCompare(b.date + (b.start || '99') + b.venue));
writeFileSync(HIST, JSON.stringify({ events: hevents }, null, 0).replace(/},{/g, '},\n{') + '\n');
console.log(hevents.length, 'history events');
console.log(JSON.stringify(status), uniq.length, 'events');
