// node test/places.test.mjs — 登録地点：住所の検索・CSVの書き出しと読み込み
import { geocode, geocodeAny, queryCandidates, placesToCsv, csvToPlaces, mergePlaces } from '../js/places.js';
import { readFileSync } from 'node:fs';

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
try { await geocode('どこにもない住所', async () => { throw new Error('net'); }); ok(false, '通信できない時は例外'); } catch (e) { ok(e.message === 'offline', '通信できない時は例外'); }
ok((await geocode('どこにもない住所', async () => res([]))) === null, '見つからない時は null');
r = await geocode('Paris', async (url) => (/gsi/.test(url) ? res([]) : res([{ lat: '48.85', lon: '2.35' }])));
ok(r === null, '日本以外の結果は使わない');
ok((await geocode('  ', gsi)) === null, '空の住所は null');

// CSV の書き出し → 読み込み
const list = [
  { id: 'a', name: '〇〇ホテル', addr: '兵庫県神戸市中央区港島中町6-10-1', kind: 'custom', lat: 34.6656, lng: 135.2089 },
  { id: 'b', name: 'ホール, "西口"', addr: '神戸市中央区港島中町6-12-2', kind: 'custom', lat: 34.6649, lng: 135.2069 },
  { id: 'c', name: '地図で追加', kind: 'custom', lat: 34.69, lng: 135.19 },
];
const csv = placesToCsv(list);
ok(csv.startsWith('\ufeff名前,住所,緯度,経度,乗車回数,時間帯,曜日'), 'CSVの見出し（Excel用BOM付き・イベントの列なし）');
const back = csvToPlaces(csv);
ok(back.items.length === 3 && !back.errors.length, `書き出したCSVを読み込める: ${back.items.length}件`);
ok(back.items[1].name === 'ホール, "西口"' && back.items[1].kind === 'custom', 'カンマ・引用符を含む名前');
ok(back.items[2].lat === 34.69 && back.items[2].name === '地図で追加', '住所なしでも緯度経度があれば読み込む');

// 名前と住所だけのCSV（緯度経度は後で調べる）、エラー行
const simple = '名前,住所\r\nA店,神戸市中央区三宮町1-1\r\n,神戸市灘区\r\nB店,\r\n';
const s2 = csvToPlaces(simple);
ok(s2.items.length === 2 && s2.items[0].lat == null && s2.items[0].kind === 'custom', '名前・住所だけのCSV');
ok(s2.items[1].name === '神戸市灘区', '名前が空なら住所を名前に');
ok(s2.errors.length === 1 && /4行目/.test(s2.errors[0]), `住所のない行はエラー: ${s2.errors[0]}`);
const s3 = csvToPlaces('名前,住所,種類,終了日時\r\nX,神戸市,イベント,2026/11/20 21:00\r\nY,神戸市,常設,\r\n');
ok(s3.items.length === 1 && s3.items[0].name === 'Y' && /イベントは使いません/.test(s3.errors[0]), '以前の形式のCSVでもイベントの行は使わない');
try { csvToPlaces('a,b\r\n1,2'); ok(false, '住所の列がないCSVを拒否'); } catch (e) { ok(/住所/.test(e.message), '住所の列がないCSVを拒否'); }

// 同じ名前・住所は上書き
const m = mergePlaces(list, [{ name: '〇〇ホテル', addr: '兵庫県神戸市中央区港島中町6-10-1', kind: 'custom', lat: 1, lng: 2 }, { name: '新規', addr: 'x', kind: 'custom', lat: 3, lng: 4 }], () => 'new');
ok(m.added === 1 && m.updated === 1 && m.list.length === 4 && m.list[0].id === 'a' && m.list[0].lat === 1, '同じ名前・住所は上書き、他は追加');

// 住所の候補
ok(JSON.stringify(queryCandidates('新神戸駅', '兵庫県神戸市中央区加納町1丁目3-1新神戸駅')) === JSON.stringify(['兵庫県神戸市中央区加納町1丁目3-1新神戸駅', '兵庫県神戸市中央区加納町1丁目3-1', '新神戸駅']), '住所の末尾の施設名を落とした候補');
ok(queryCandidates('', 'コンフォートホテルERA神戸三宮').length === 1, '住所でない名前（〜三宮）は切らない');

// 調べた結果を覚える。通信できない時は覚えない
const cache = {};
let n = 0;
const counting = async (url) => { n++; return /gsi/.test(url) ? res(/ない/.test(decodeURIComponent(url)) ? [] : [{ geometry: { coordinates: [135.2, 34.69] }, properties: { title: 't' } }]) : res([]); };
await geocodeAny(['神戸市中央区A'], cache, {}, counting); await geocodeAny(['神戸市中央区A'], cache, {}, counting);
ok(n === 1 && cache['神戸市中央区A'].lat === 34.69, '同じ住所は2回目から調べない');
r = await geocodeAny(['ない住所', '神戸市中央区A'], cache, {}, counting);
ok(r && cache['ない住所'].miss === 1, '見つからない候補は覚えて、次の候補で見つける');
r = await geocodeAny(['新しい住所'], cache, {}, async () => { throw new Error('net'); });
ok(r === null && !('新しい住所' in cache), '通信できない時は覚えない');

// 近くの範囲：遠い同名の場所は使わない
r = await geocode('モザイク', async (url) => (/gsi/.test(url) ? res([{ geometry: { coordinates: [139.7, 35.6] }, properties: { title: '東京のモザイク' } }]) : res([])), { near: [135.19, 34.69] });
ok(r === null, '近く（60km）以外の結果は使わない');

// 実際の営業ログ形式（施設・手入力で緯度経度なし）
const logHead = '日時,営業日,種別,ステータス,備考,運賃合計,運賃,迎車料金,アプリ手数料,取扱手数料,遠距離割,障害者割,高速代,迎車なし,決済方法,チケットの種類,乗車種別,配車アプリ,乗車時刻,乗車施設,乗車住所,乗車住所の入力,乗車緯度,乗車経度,降車施設,降車住所,降車住所の入力,降車緯度,降車経度';
const lrow = (ts, kind, fac, addr, how) => [ts, ts.slice(0, 10), '乗車記録', '実車', '', 1600, 1600, 0, 0, '', '', '', '', '', '現金', '', kind, '', ts, fac, addr, how, '', '', '', '', '', '', ''].join(',');
const log = [logHead, '2026/10/22 10:00:00,2026/10/22,ステータス,空車,出庫,,,,,,,,,,,,,,,,,,,,,,,,',
  lrow('2026/10/22 10:47:00', '乗り場', '新神戸駅（施設）', '兵庫県神戸市中央区加納町一丁目', '施設'),
  lrow('2026/10/23 10:47:00', '乗り場', '新神戸駅（施設）', '兵庫県神戸市中央区加納町1丁目3-1新神戸駅', '施設'),
  lrow('2026/10/23 11:47:00', '乗り場', '新神戸駅（施設）', '兵庫県神戸市中央区加納町一丁目', '施設'),
  lrow('2026/10/24 12:00:00', '流し', '', 'コンフォートホテルERA神戸三宮', '手入力'),
  lrow('2026/10/24 13:00:00', '流し', '三ノ宮駅（施設）', '', '施設')].join('\r\n');
const lp = csvToPlaces('\ufeff' + log);
ok(lp.analyzer && lp.analyzer.total === 5 && lp.items.length === 3, `営業ログ→乗車した場所 ${lp.items.length}か所（乗車 ${lp.analyzer && lp.analyzer.total}件）`);
ok(lp.items[0].name === '新神戸駅' && lp.items[0].rides === 3 && lp.items[0].addr === '兵庫県神戸市中央区加納町一丁目' && lp.items[0].lat == null, '同じ施設はまとめ、多い住所を代表に');
ok(lp.items[0].q.includes('兵庫県神戸市中央区加納町1丁目3-1') && lp.items[0].q.includes('新神戸駅'), `調べる候補: ${lp.items[0].q.join(' / ')}`);
ok(lp.items.some((x) => x.name === 'コンフォートホテルERA神戸三宮' && x.rides === 1), '手入力の施設名もまとめる');

// アップロードされた実データ（あれば）
const real = process.env.REAL_CSV;
if (real) {
  const rp = csvToPlaces(readFileSync(real, 'utf8'), { kinds: { street: true, stand: false, app: false } });
  console.log(`実データ: 乗車 ${rp.analyzer.total}件（流しのみ ${rp.analyzer.used}件） → ${rp.items.length}か所 / 上位: ${rp.items.slice(0, 5).map((x) => `${x.name}(${x.rides})`).join('、')} / エラー ${rp.errors.length}`);
  ok(rp.items.length > 0 && rp.items.every((x) => x.q.length), '実データの全地点に調べる候補がある');
}

// 乗車の種類で絞る（初期は流しだけ）
const kl = csvToPlaces('\ufeff' + log, { kinds: { street: true, stand: false, app: false } });
ok(kl.analyzer.used === 2 && !kl.items.some((x) => x.name === '新神戸駅'), `乗り場を除くと流しの ${kl.analyzer.used}件だけ`);
// 読み込み直すと、営業ログ由来で対象外になった地点は消える（手で登録した地点は残る）
const before = [{ id: 'm', name: '手で登録', addr: 'x', kind: 'custom', lat: 1, lng: 1 }, { id: 'l', name: '新神戸駅', addr: '兵庫県神戸市中央区加納町一丁目', kind: 'custom', rides: 3, lat: 1, lng: 1 }];
const mr = mergePlaces(before, kl.items.map((x) => ({ ...x, lat: 1, lng: 1 })), () => 'n', { replaceLog: true });
ok(mr.removed === 1 && mr.list.some((x) => x.id === 'm') && !mr.list.some((x) => x.name === '新神戸駅') && mr.added === 2, `対象外の地点を削除 ${mr.removed}件・手で登録した地点は残る`);

console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
