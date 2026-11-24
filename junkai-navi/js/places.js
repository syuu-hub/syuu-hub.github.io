// 登録地点（任意で設定する需要地点・イベント会場）
// ・住所から緯度経度を調べる（国土地理院の住所検索 → 見つからなければ OpenStreetMap の Nominatim）
// ・CSV への書き出しと読み込み
import { fetchT } from './sources.js?v=24';
import { parseCsv, importAnalyzerCsv, placeKey, rideFilter } from './csv.js?v=24';
import { haversine } from './geo.js?v=24';
import { inRegion, REGION_BOUNDS } from './region.js?v=24';
import { logProf, manualProf, parseHours, parseDays, hoursText, daysText } from './profile.js?v=24';

// 日本付近の座標か
export const inJapan = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46 && lng > 122 && lng < 154;

// 住所（または施設名）→ { lat, lng, title }。見つからなければ null。どちらの検索にもつながらなければ例外（'offline'）
// near: [lng, lat] を渡すと、そこから maxKm 以内の結果だけ使う（同じ名前の別の場所を拾わないように）
export async function geocode(addr, fetcher = fetchT, { near = null, maxKm = 60 } = {}) {
  const q = String(addr || '').trim();
  if (!q) return null;
  // 関西圏の外の結果は使わない（同じ名前の他の地域の場所を拾わないように）
  const okPos = (lat, lng) => inJapan(lat, lng) && inRegion(lng, lat) && (!near || haversine(near, [lng, lat]) <= maxKm * 1000);
  // 施設名だけで探す時に、近くの範囲に絞って OpenStreetMap を検索する
  let reached = false;
  const [w, s, e, n] = REGION_BOUNDS;
  const box = near ? `&bounded=1&viewbox=${near[0] - 0.6},${near[1] + 0.5},${near[0] + 0.6},${near[1] - 0.5}` : `&bounded=1&viewbox=${w},${n},${e},${s}`;
  try {
    const res = await fetcher(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`, {}, 10000);
    if (res.ok) {
      reached = true;
      const list = await res.json();
      const hit = Array.isArray(list) && list.find((f) => f && f.geometry && Array.isArray(f.geometry.coordinates));
      if (hit) {
        const [lng, lat] = hit.geometry.coordinates.map(Number);
        if (okPos(lat, lng)) return { lat, lng, title: (hit.properties && hit.properties.title) || q };
      }
    }
  } catch { /* 次の検索へ */ }
  try {
    const res = await fetcher(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&accept-language=ja${box}&q=${encodeURIComponent(q)}`, {}, 10000);
    if (res.ok) {
      reached = true;
      const list = await res.json();
      const hit = Array.isArray(list) && list[0];
      if (hit) {
        const lat = +hit.lat, lng = +hit.lon;
        if (okPos(lat, lng)) return { lat, lng, title: hit.display_name || q };
      }
    }
  } catch { /* 見つからない */ }
  if (!reached) throw new Error('offline');
  return null;
}

// 調べる文字列の候補：住所 → 住所の末尾の施設名を除いたもの → 施設名
// 例「…加納町1丁目3-1新神戸駅」→「…加納町1丁目3-1」
export function queryCandidates(name, addr) {
  const a = String(addr || '').trim(), n = String(name || '').trim();
  // 住所（市区町村を含む）の時だけ、最後の数字・丁目より後ろを落とす
  const m = /[都道府県市区町村]/.test(a) && /^(.*(?:[0-9０-９]|丁目)(?:番地?|号)?)/.exec(a);
  const cut = m && m[1].length < a.length ? m[1] : '';
  return [...new Set([a, cut, n].filter((x) => x && x.length >= 2))];
}

// 候補を順に調べ、結果を cache（{ 文字列: {lat,lng,title} | {miss:1} }）に残す
export async function geocodeAny(queries, cache = {}, opts = {}, fetcher = fetchT) {
  for (const q of queries) {
    const c = cache[q];
    if (c && !c.miss) return c;
    if (c && c.miss) continue;
    let hit;
    try { hit = await geocode(q, fetcher, opts); }
    catch { return null; } // 通信できない時は「見つからない」と覚えない（後でもう一度調べる）
    cache[q] = hit ? { lat: +hit.lat.toFixed(6), lng: +hit.lng.toFixed(6), title: hit.title } : { miss: 1 };
    if (hit) return cache[q];
    if (opts.wait) await new Promise((r) => setTimeout(r, opts.wait));
  }
  return null;
}

// 地点の中心（中央値）。施設名だけの検索を、この近くに絞るのに使う
export function centerOf(points) {
  const p = points.filter((x) => x && x.lat != null);
  if (!p.length) return null;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  return [med(p.map((x) => x.lng)), med(p.map((x) => x.lat))];
}

const shortName = (a) => String(a || '').replace(/^.{2,3}?[都道府県]/, '').replace(/^[^市]{1,6}市(?=[^市]+区)/, '') || a;

// タクシーアナライザの営業ログ → 乗車した場所ごとにまとめた登録地点（乗車回数つき）
// kinds：使う乗車の種類 { street, stand, app }（省略時はすべて）
export function analyzerToPlaces(text, { kinds = null } = {}) {
  const all = importAnalyzerCsv(text);
  const { total, skipped } = all;
  const rides = kinds ? all.rides.filter(rideFilter(kinds)) : all.rides;
  const by = new Map();
  for (const r of rides) {
    const k = placeKey(r);
    let g = by.get(k);
    // 施設名がなければ住所を短くして名前に（「兵庫県神戸市長田区大橋町4丁目1-10」→「長田区大橋町4丁目1-10」）
    if (!g) { g = { name: r.fac || shortName(r.addr), addrs: new Map(), rides: 0, lat: null, lng: null, times: [] }; by.set(k, g); }
    g.rides++;
    g.times.push(r.t); // 乗車した時刻・曜日の傾向に使う
    if (r.addr) g.addrs.set(r.addr, (g.addrs.get(r.addr) || 0) + 1);
    if (r.lat != null && g.lat == null) { g.lat = r.lat; g.lng = r.lng; }
  }
  const items = [...by.values()].map((g) => {
    const addrs = [...g.addrs.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const addr = addrs[0] || '';
    const it = { name: g.name, addr, kind: 'custom', rides: g.rides, fromLog: true, prof: logProf(g.times), q: [...new Set(addrs.flatMap((a) => queryCandidates(g.name, a)).concat(queryCandidates(g.name, '')))] };
    if (g.lat != null) { it.lat = +g.lat.toFixed(6); it.lng = +g.lng.toFixed(6); }
    return it;
  }).sort((a, b) => b.rides - a.rides);
  return { items, total, used: rides.length, skipped };
}
export const isAnalyzerLog = (head) => head.includes('種別') && (head.includes('乗車住所') || head.includes('乗車施設'));

// ===== CSV =====
export const PLACE_HEAD = ['名前', '住所', '緯度', '経度', '乗車回数', '時間帯', '曜日'];
const pad = (n) => String(n).padStart(2, '0');
export const fmtStamp = (t) => { const d = new Date(t); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const cell = (v) => { if (v == null) return ''; v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

export function placesToCsv(list) {
  const rows = [PLACE_HEAD];
  for (const p of list) {
    rows.push([
      p.name, p.addr || '',
      p.lat != null ? (+p.lat).toFixed(6) : '', p.lng != null ? (+p.lng).toFixed(6) : '', p.rides || '',
      hoursText(p.prof), daysText(p.prof),
    ]);
  }
  return '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// 戻り値：{ items: [{name, addr, kind, end?, size?, lat?, lng?}], errors: [行番号: 理由] }
// 緯度・経度が無い行は、取り込み時に住所から調べる
export function csvToPlaces(text, { kinds = null } = {}) {
  text = String(text || '').replace(/^\ufeff/, '');
  const rows = parseCsv(text);
  const head = (rows.shift() || []).map((h) => h.trim());
  // タクシーアナライザの営業ログなら、乗車した場所ごとにまとめる
  if (isAnalyzerLog(head)) {
    const { items, total, used, skipped } = analyzerToPlaces(text, { kinds });
    return { items, errors: skipped ? [`位置も施設名・住所もない乗車 ${skipped}件`] : [], analyzer: { total, used } };
  }
  const ci = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iName = ci('名前', '名称', '施設名'), iAddr = ci('住所', '所在地'), iKind = ci('種類', '種別');
  const iLat = ci('緯度', 'lat'), iLng = ci('経度', 'lng', 'lon'), iRides = ci('乗車回数'), iHours = ci('時間帯'), iDays = ci('曜日');
  if (iAddr < 0 && (iLat < 0 || iLng < 0)) throw new Error('「住所」の列（または「緯度」「経度」の列）があるCSVを選んでください');
  const get = (r, i) => (i < 0 ? '' : String(r[i] ?? '').trim());
  const items = [], errors = [];
  rows.forEach((r, n) => {
    const line = n + 2;
    const addr = get(r, iAddr);
    const name = get(r, iName) || addr;
    let lat = parseFloat(get(r, iLat)), lng = parseFloat(get(r, iLng));
    if (!inJapan(lat, lng)) { lat = null; lng = null; }
    if (!addr && lat == null) { errors.push(`${line}行目：住所がありません`); return; }
    // イベントは使わない（以前の形式のCSVでも、イベントの行は読み飛ばす）
    if (/イベント|event/i.test(get(r, iKind))) { errors.push(`${line}行目：イベントは使いません`); return; }
    const item = { name, addr, kind: 'custom' };
    if (lat != null) { item.lat = lat; item.lng = lng; }
    const rides = parseInt(get(r, iRides), 10);
    if (rides > 0) item.rides = rides;
    // 時間帯（例 7-10, 18-24）・曜日（例 平日、土日、月水金）。どちらも空なら一日中同じ
    const prof = manualProf(parseHours(get(r, iHours)), parseDays(get(r, iDays)));
    if (prof) item.prof = prof;
    items.push(item);
  });
  return { items, errors };
}

// 同じ名前・住所の地点は上書き、それ以外は追加。戻り値：{ list, added, updated, removed }
// replaceLog：営業ログから登録した地点のうち、今回の読み込みに含まれないもの（除外した種類の乗車だけの場所など）を消す
export function mergePlaces(list, incoming, newId = () => 'u' + Date.now() + Math.random().toString(36).slice(2, 6), { replaceLog = false } = {}) {
  const same = (p, it) => p.name === it.name && (p.addr || '') === (it.addr || '');
  const isLog = (p) => p.fromLog || (p.kind !== 'event' && p.rides > 0);
  const kept = replaceLog ? list.filter((p) => !isLog(p) || incoming.some((it) => same(p, it))) : list;
  const removed = list.length - kept.length;
  const out = kept.slice();
  let added = 0, updated = 0;
  for (const it of incoming) {
    const i = out.findIndex((p) => same(p, it));
    if (i >= 0) {
      const keep = out[i].prof && out[i].prof.src === 'manual' && (!it.prof || it.prof.src === 'log') ? { prof: out[i].prof } : {};
      out[i] = { ...out[i], ...it, ...keep, id: out[i].id }; updated++;
    }
    else { out.push({ ...it, id: newId() }); added++; }
  }
  return { list: out, added, updated, removed };
}
