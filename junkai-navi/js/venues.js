// 神戸の主要会場のイベント（タクシーアナライザと共通の taxi-analyzer/events.json。GitHub Actions が毎日1回、各会場の公式サイトから作る）
// → 巡回ナビの需要イベントにする（終演の30分前から上がり、終演10分後がピーク、60分後まで）
// 会場の位置はおおよそ（需要エリアは約450m四方なので、出入口の位置まで細かくなくてよい）

export const EVENTS_URL = '../taxi-analyzer/events.json';

// [経度, 緯度]
export const VENUES = {
  'ワールド記念ホール': [135.2118, 34.6668],
  '神戸国際展示場': [135.2127, 34.6656],
  '神戸国際会議場': [135.2140, 34.6651],
  '神戸国際会館こくさいホール': [135.1977, 34.6929],
  '神戸文化ホール 大ホール': [135.1714, 34.6827],
  '神戸文化ホール 中ホール': [135.1714, 34.6827],
  'ノエビアスタジアム神戸': [135.1690, 34.6567],
  'GLION ARENA KOBE': [135.1958, 34.6853],
  '阪神甲子園球場': [135.3616, 34.7213],
  'ほっともっとフィールド神戸': [135.0779, 34.6797],
  '神戸ポートターミナル': [135.2005, 34.6808],
  '中突堤旅客ターミナル': [135.1866, 34.6823],
};

// 収容人数 → 規模（需要の大きさ：小1・中3・大6）
export const sizeOf = (cap) => (cap >= 10000 ? 'l' : cap >= 3000 ? 'm' : 's');

const at = (date, hm) => (date && hm ? new Date(`${date}T${hm}:00+09:00`) : null);

// events.json → 需要イベント [{ id, name, lng, lat, end, size, kind:'event', auto:true, venue, title }]
// from〜to（ミリ秒）に需要がかかるものだけ。会場の位置が分からないもの、時刻が無いものは使わない
export function venueEvents(json, { from = Date.now() - 2 * 3600e3, to = Date.now() + 36 * 3600e3 } = {}) {
  const list = (json && Array.isArray(json.events)) ? json.events : [];
  const out = [];
  for (const e of list) {
    const pos = VENUES[e.venue];
    if (!pos) continue;
    let t;
    if (e.ship) {
      // 客船：入港してから下船・観光に出るので、入港の30分後を「終わり」とみなす
      const a = at(e.date, e.start);
      t = a ? new Date(a.getTime() + 30 * 60e3) : null;
    } else {
      t = at(e.date, e.end);
      const s = at(e.date, e.start);
      if (t && s && t < s) t = new Date(t.getTime() + 864e5); // 日をまたぐ
    }
    if (!t || isNaN(t) || t.getTime() < from || t.getTime() > to) continue;
    out.push({
      id: `auto:${e.venue}:${t.getTime()}`,
      name: e.venue,
      title: e.title || '',
      venue: e.venue,
      lng: pos[0], lat: pos[1],
      end: t.toISOString(),
      size: e.ship ? 'm' : sizeOf(e.cap || 0),
      kind: 'event',
      auto: true,
    });
  }
  // 同じ会場・同じ時刻は1つに（複数の公演が同じ時刻に終わる時など）
  const seen = new Set();
  return out.filter((x) => (seen.has(x.id) ? false : seen.add(x.id))).sort((a, b) => new Date(a.end) - new Date(b.end));
}
