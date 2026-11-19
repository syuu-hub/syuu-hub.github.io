// node test/places.test.mjs — 登録地点：住所の検索・CSVの書き出しと読み込み
import { geocode, placesToCsv, csvToPlaces, mergePlaces } from '../js/places.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };
const res = (body, okk = true) => ({ ok: okk, json: async () => body });

// 国土地理院で見つかる
let calls = [];
const gsi = async (url) => { calls.push(url); return /gsi/.test(url) ? res([{ geometry: { coordinates: [135.1955, 34.6913] }, properties: { title: '兵庫県神戸市中央区加納町六丁目' } }]) : res([]); };
let r = await geocode('兵庫県神戸市中央区加納町6-5-1', gsi);
ok(r && Math.abs(r.lat - 34.6913) < 1e-6 && r.title.includes('加納町'), `住所→位置（国土地理院）: ${r && r.title}`);
ok(calls.length === 1, '国土地理院で見つかれば他は使わない');

// 国土地理院で見つからなければ Nominatim
calls = [];
const nomi = async (url) => { calls.push(url); return /gsi/.test(url) ? res([]) : res([{ lat: '34.6795', lon: '135.1781', display_name: '神戸駅' }]); };
r = await geocode('神戸駅', nomi);
ok(r && Math.abs(r.lng - 135.1781) < 1e-6 && calls.length === 2, `施設名→位置（Nominatim）: ${r && r.title}`);

// どちらも失敗・日本以外は null
r = await geocode('どこにもない住所', async () => { throw new Error('offline'); });
ok(r === null, '通信できない時は null');
r = await geocode('Paris', async (url) => (/gsi/.test(url) ? res([]) : res([{ lat: '48.85', lon: '2.35' }])));
ok(r === null, '日本以外の結果は使わない');
ok((await geocode('  ', gsi)) === null, '空の住所は null');

// CSV の書き出し → 読み込み
const list = [
  { id: 'a', name: '〇〇ホテル', addr: '兵庫県神戸市中央区港島中町6-10-1', kind: 'custom', lat: 34.6656, lng: 135.2089 },
  { id: 'b', name: 'ワールド記念ホール, "ライブ"', addr: '神戸市中央区港島中町6-12-2', kind: 'event', end: new Date(2026, 10, 20, 21, 0).toISOString(), size: 'l', lat: 34.6649, lng: 135.2069 },
  { id: 'c', name: '地図で追加', kind: 'custom', lat: 34.69, lng: 135.19 },
];
const csv = placesToCsv(list);
ok(csv.startsWith('﻿名前,住所,種類,終了日時,規模,緯度,経度'), 'CSVの見出し（Excel用BOM付き）');
const back = csvToPlaces(csv);
ok(back.items.length === 3 && !back.errors.length, `書き出したCSVを読み込める: ${back.items.length}件`);
ok(back.items[1].name === 'ワールド記念ホール, "ライブ"' && back.items[1].kind === 'event' && back.items[1].size === 'l', 'カンマ・引用符を含む名前、イベント・規模');
ok(new Date(back.items[1].end).getHours() === 21 && new Date(back.items[1].end).getDate() === 20, `終了日時: ${back.items[1].end}`);
ok(back.items[2].lat === 34.69 && back.items[2].name === '地図で追加', '住所なしでも緯度経度があれば読み込む');

// 名前と住所だけのCSV（緯度経度は後で調べる）、エラー行
const simple = '名前,住所\r\nA店,神戸市中央区三宮町1-1\r\n,神戸市灘区\r\nB店,\r\n';
const s2 = csvToPlaces(simple);
ok(s2.items.length === 2 && s2.items[0].lat == null && s2.items[0].kind === 'custom', '名前・住所だけのCSV');
ok(s2.items[1].name === '神戸市灘区', '名前が空なら住所を名前に');
ok(s2.errors.length === 1 && /4行目/.test(s2.errors[0]), `住所のない行はエラー: ${s2.errors[0]}`);
const s3 = csvToPlaces('名前,住所,種類\r\nX,神戸市,イベント\r\n');
ok(!s3.items.length && /終了日時/.test(s3.errors[0]), 'イベントに終了日時がなければエラー');
try { csvToPlaces('a,b\r\n1,2'); ok(false, '住所の列がないCSVを拒否'); } catch (e) { ok(/住所/.test(e.message), '住所の列がないCSVを拒否'); }

// 同じ名前・住所は上書き
const m = mergePlaces(list, [{ name: '〇〇ホテル', addr: '兵庫県神戸市中央区港島中町6-10-1', kind: 'custom', lat: 1, lng: 2 }, { name: '新規', addr: 'x', kind: 'custom', lat: 3, lng: 4 }], () => 'new');
ok(m.added === 1 && m.updated === 1 && m.list.length === 4 && m.list[0].id === 'a' && m.list[0].lat === 1, '同じ名前・住所は上書き、他は追加');

console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
