// TZ=Asia/Tokyo node test/venues.test.mjs — 神戸の会場のイベント（events.json）を需要イベントにする
import { readFileSync } from 'node:fs';
import { venueEvents, VENUES, sizeOf } from '../js/venues.js';
import { inRegion } from '../js/region.js';
import { DemandEngine } from '../js/demand.js';
import { haversine } from '../js/geo.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };

ok(Object.values(VENUES).every(([lng, lat]) => inRegion(lng, lat)), `会場 ${Object.keys(VENUES).length} か所はすべて関西圏`);
ok(sizeOf(30000) === 'l' && sizeOf(5000) === 'm' && sizeOf(900) === 's', '収容人数→規模');

const json = { events: [
  { date: '2026-11-20', start: '19:00', end: '21:00', venue: 'ノエビアスタジアム神戸', cap: 30000, title: 'ヴィッセル神戸 vs 水戸' },
  { date: '2026-11-20', start: '19:00', end: '21:30', venue: '神戸国際会館こくさいホール', cap: 2000, title: 'コンサート' },
  { date: '2026-11-20', start: '22:30', end: '00:30', venue: 'GLION ARENA KOBE', cap: 10000, title: '深夜まで' },
  { date: '2026-11-20', start: '17:00', end: null, venue: '神戸ポートターミナル', cap: 3000, title: '客船', ship: true },
  { date: '2026-11-20', start: '18:00', end: '20:00', venue: '知らない会場', cap: 500, title: 'x' },
  { date: '2026-11-20', start: null, end: null, venue: 'ワールド記念ホール', cap: 8000, title: '時刻なし' },
  { date: '2026-12-25', start: '18:00', end: '20:00', venue: 'ワールド記念ホール', cap: 8000, title: 'ずっと先' },
] };
const now = new Date('2026-11-20T18:00:00+09:00').getTime();
const evs = venueEvents(json, { from: now - 2 * 3600e3, to: now + 36 * 3600e3 });
ok(evs.length === 4, `使えるイベント ${evs.length} 件（会場不明・時刻なし・先すぎるものは除く）`);
const noe = evs.find((e) => e.venue === 'ノエビアスタジアム神戸');
ok(noe.size === 'l' && new Date(noe.end).getHours() === 21, '試合は終了時刻・大規模');
const gl = evs.find((e) => e.venue === 'GLION ARENA KOBE');
ok(new Date(gl.end).getDate() === 21 && new Date(gl.end).getHours() === 0, '日をまたぐ終了は翌日');
const ship = evs.find((e) => e.venue === '神戸ポートターミナル');
ok(new Date(ship.end).getHours() === 17 && new Date(ship.end).getMinutes() === 30, '客船は入港の30分後');

// 需要：試合終了の10分後、スタジアム周辺が最上位に
const dm = new DemandEngine();
dm.spots = [{ id: 's', name: '三宮駅', lng: 135.1955, lat: 34.6946, cat: 'station' }];
dm.events = evs;
dm.update(new Date('2026-11-20T21:10:00+09:00'), 1);
const top = [...dm.areas.values()].sort((a, b) => b.score - a.score)[0];
ok(haversine(top.center, VENUES['ノエビアスタジアム神戸']) < 500, `21:10 の最上位はスタジアム周辺（${top.name}）`);
dm.areas = new Map();
dm.update(new Date('2026-11-20T18:00:00+09:00'), 1);
const top2 = [...dm.areas.values()].sort((a, b) => b.score - a.score)[0];
ok(haversine(top2.center, VENUES['ノエビアスタジアム神戸']) > 1000, `試合中（18:00）はスタジアムに向かわない（最上位：${top2.name}）`);

// 実際の events.json
const real = JSON.parse(readFileSync(new URL('../../taxi-analyzer/events.json', import.meta.url), 'utf8'));
const all = venueEvents(real, { from: 0, to: Infinity });
const unknown = [...new Set(real.events.map((e) => e.venue))].filter((v) => !VENUES[v]);
console.log(`実データ：${real.events.length} 件 → 需要イベント ${all.length} 件 / 位置が分からない会場 ${unknown.length ? unknown.join('、') : 'なし'}`);
ok(unknown.length === 0, 'events.json の会場はすべて位置が分かる');
// 始まる時刻の前後は需要にしない（終わった後だけ）
{
  const d = new DemandEngine();
  d.events = venueEvents({ events: [{ date: '2026-11-20', start: '19:00', end: '21:00', venue: 'ノエビアスタジアム神戸', cap: 30000, title: '試合' }] }, { from: 0, to: Infinity });
  const at = (hm) => { d.areas = new Map(); d.update(new Date(`2026-11-20T${hm}:00+09:00`), 1); return [...d.areas.values()].reduce((s, a) => s + a.score, 0); };
  ok(at('18:45') === 0 && at('19:10') === 0 && at('20:30') === 0, '開始の前後・試合中は需要なし');
  ok(at('20:55') > 0 && at('21:15') > at('20:55') && at('21:15') > at('21:50'), `終了10分前から上がり、15分後がピーク（20:55 ${at('20:55').toFixed(2)} / 21:15 ${at('21:15').toFixed(2)} / 21:50 ${at('21:50').toFixed(2)}）`);
  ok(at('22:05') === 0, '終了60分後で終わり');
  ok(venueEvents({ events: [{ date: '2026-11-20', start: '19:00', end: null, venue: 'GLION ARENA KOBE', cap: 10000, title: '終わり不明' }] }, { from: 0, to: Infinity }).length === 0, '終わる時刻が分からないイベントは使わない');
}
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
