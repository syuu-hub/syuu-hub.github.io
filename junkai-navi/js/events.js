// イベント情報（taxi-analyzer/events.json、神戸の主要会場の公式サイトから毎日集めたもの）と、
// 営業ログで「降車地がイベント会場」だった乗車から、イベントの前に会場へ向かうお客様を乗せやすい場所を見つける
//
// 考え方：イベントの前は、会場へ向かう人がタクシーに乗る。どこから乗るかは会場・地域で違うので、
// 決め打ちせず、自分の営業ログで実際に会場まで乗せた乗車の乗車地（よく乗せた場所）を使う。
// 乗り場（駅のタクシー乗り場など）からの乗車は、待っていれば乗れる場所なので巡回先にしない（除く）

// 会場：events.json の会場名・営業ログの降車施設・降車住所に出てくる名前。addr は所在地（同じ名前の別の場所を除く）
export const VENUES = {
  glion: { name: 'GLION ARENA KOBE', alias: ['GLION ARENA', 'ジーライオンアリーナ', 'ジーライオン アリーナ'], addr: /神戸市中央区|新港町/ },
  world: { name: 'ワールド記念ホール', alias: ['ワールド記念ホール'], addr: /神戸市中央区|港島/ },
  kih: { name: '神戸国際会館', alias: ['神戸国際会館', '国際会館こくさいホール'], addr: /神戸市中央区|御幸通/ },
  bunka: { name: '神戸文化ホール', alias: ['神戸文化ホール'], addr: /神戸市中央区|楠町/ },
  kccEx: { name: '神戸国際展示場', alias: ['神戸国際展示場'], addr: /神戸市中央区|港島/ },
  kccCv: { name: '神戸国際会議場', alias: ['神戸国際会議場'], addr: /神戸市中央区|港島/ },
  noesta: { name: 'ノエビアスタジアム神戸', alias: ['ノエビアスタジアム'], addr: /神戸市兵庫区|御崎/ },
  koshien: { name: '阪神甲子園球場', alias: ['甲子園球場'], addr: /西宮市|甲子園/ },
  hotto: { name: 'ほっともっとフィールド神戸', alias: ['ほっともっとフィールド'], addr: /神戸市須磨区|緑台/ },
  portT: { name: '神戸ポートターミナル', alias: ['神戸ポートターミナル'], addr: /神戸市中央区|港島/ },
  nakaT: { name: '中突堤旅客ターミナル', alias: ['中突堤旅客ターミナル', '中突堤'], addr: /神戸市中央区|波止場/ },
};

const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
// 名前（施設名・会場名）と住所 → 会場のキー（会場でなければ null）
// 住所があって所在地と合わない時は別の場所（例：京都の「国際会館」）
export function venueKey(name, addr = '') {
  const n = norm(name), a = norm(addr);
  for (const [k, v] of Object.entries(VENUES)) {
    if (!v.alias.some((x) => n.includes(norm(x)) || (!n && a.includes(norm(x))))) continue;
    if (a && /[都道府県]/.test(a) && !v.addr.test(a)) continue;
    return k;
  }
  return null;
}

const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})/.exec(hm || ''); return m ? +m[1] * 60 + +m[2] : null; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 会場へ向かう人がタクシーに乗る時間帯の重み（0〜1）
// 開演の2時間半前から10分前まで（開場時刻があれば、開場の1時間半前から）。前後20分はなめらかに増減
// 開演時刻のないイベント（展示会など）は 9〜12時を半分の重みで
export const LEAD_MIN = 150, LAST_MIN = 10, EDGE_MIN = 20;
export function eventWindow(ev, now) {
  if (!ev || ev.date !== ymd(now)) return 0;
  const t = now.getHours() * 60 + now.getMinutes();
  const st = toMin(ev.start), op = toMin(ev.open);
  if (st == null) return t >= 9 * 60 && t <= 12 * 60 ? 0.5 : 0;
  const from = Math.min(st - LEAD_MIN, op != null ? op - 90 : Infinity), to = st - LAST_MIN;
  if (t < from - EDGE_MIN || t > to + EDGE_MIN) return 0;
  if (t < from) return (t - (from - EDGE_MIN)) / EDGE_MIN;
  if (t > to) return ((to + EDGE_MIN) - t) / EDGE_MIN;
  return 1;
}

// 会場の大きさ：収容人数の平方根で（5000人を1。0.5〜2倍）
export const capFactor = (cap) => Math.max(0.5, Math.min(2, Math.sqrt((cap || 5000) / 5000)));

// 今の時刻にイベントの前の需要がある会場 → { key: { w, events: [タイトル…] } }
export function activeVenues(events, now) {
  const out = {};
  for (const ev of events || []) {
    const k = venueKey(ev.venue);
    if (!k) continue;
    const w = eventWindow(ev, now) * capFactor(ev.cap);
    if (w <= 0) continue;
    const o = out[k] || (out[k] = { w: 0, events: [] });
    o.w = Math.max(o.w, w);
    o.events.push(ev.title);
  }
  return out;
}
