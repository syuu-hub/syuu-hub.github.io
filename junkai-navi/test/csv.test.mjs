// node test/csv.test.mjs — タクシーアナライザ営業ログCSVの取り込みと需要計算
import { decodeCsv, importAnalyzerCsv, isStreetRide } from '../js/csv.js';
import { DemandEngine } from '../js/demand.js';

const head = ['日時', '営業日', '種別', 'ステータス', '備考', '運賃合計', '運賃', '迎車料金', 'アプリ手数料', '取扱手数料', '遠距離割', '障害者割', '高速代', '迎車なし', '決済方法', 'チケットの種類', '乗車種別', '配車アプリ', '乗車時刻', '乗車施設', '乗車住所', '乗車住所の入力', '乗車緯度', '乗車経度', '降車施設', '降車住所', '降車住所の入力', '降車緯度', '降車経度'];
const cell = (v) => { if (v == null) return ''; v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const row = (o) => head.map((h) => cell(o[h])).join(',');
const lines = [head.join(',')];
lines.push(row({ 日時: '2026/11/16 07:58:00', 種別: 'ステータス', ステータス: '空車', 備考: '出庫' }));
const add = (ts, kind, app, fac, addr, lat, lng, fare) => lines.push(row({ 日時: ts, 営業日: ts.slice(0, 10), 種別: '乗車記録', ステータス: '実車', 運賃合計: fare, 乗車種別: kind, 配車アプリ: app, 乗車時刻: ts, 乗車施設: fac, 乗車住所: addr, 乗車住所の入力: fac ? '施設' : 'GPS', 乗車緯度: lat, 乗車経度: lng }));
for (let d = 10; d <= 16; d++) {
  add(`2026/11/${d} 08:1${d % 10}:00`, '流し', '', '東京駅（駅）', '東京都千代田区丸の内1丁目9', 35.6812, 139.7671, 1800);
  add(`2026/11/${d} 08:4${d % 10}:00`, '乗り場', '', '', '東京都中央区銀座4丁目, 1-2', 35.6717, 139.7650, 2400);
  add(`2026/11/${d} 22:30:00`, '流し', '', '新橋駅（駅）', '', 35.6663, 139.7583, 5200);
  add(`2026/11/${d} 09:00:00`, 'アプリ配車', 'GO', '', '東京都港区', 35.6586, 139.7454, 1500);
}
add('2026/11/16 10:00:00', '流し', '', '', '', '', '', 1000); // 位置なし
const text = '﻿' + lines.join('\r\n') + '\r\n';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };

const { rides, total, skipped } = importAnalyzerCsv(decodeCsv(new TextEncoder().encode(text)));
ok(total === 29 && rides.length === 28 && skipped === 1, `乗車記録 ${total} 件 / 取り込み ${rides.length} / 除外 ${skipped}`);
ok(rides[0].name === '東京駅', `施設名の種別を除去: ${rides[0].name}`);
ok(rides.find((r) => r.lat === 35.6717).name && !/\d$/.test(rides.find((r) => r.lat === 35.6717).name), `住所から短い名前: ${rides.find((r) => r.lat === 35.6717).name}`);
ok(rides.filter(isStreetRide).length === 21, `流し・乗り場のみ: ${rides.filter(isStreetRide).length}`);

// Shift_JIS で保存し直したCSVも読める（Node に Shift_JIS エンコーダがないので、ヘッダー検出の失敗時メッセージだけ確認）
try { importAnalyzerCsv('a,b\n1,2'); ok(false, '別形式のCSVを拒否'); } catch (e) { ok(/営業ログ/.test(e.message), '別形式のCSVを拒否'); }

const dm = new DemandEngine();
dm.csvRides = rides.filter(isStreetRide);
dm.update(new Date('2026-11-17T08:20:00+09:00'), 1);
const morning = [...dm.areas.values()].sort((a, b) => b.score - a.score);
ok(morning[0] && /東京駅|銀座/.test(morning[0].name), `朝8時の最上位: ${morning[0] && morning[0].name}`);
dm.areas = new Map();
dm.update(new Date('2026-11-17T22:20:00+09:00'), 1);
const night = [...dm.areas.values()].sort((a, b) => b.score - a.score);
ok(night[0] && night[0].name === '新橋駅', `夜22時の最上位: ${night[0] && night[0].name}`);
const r = dm.rank([139.7671, 35.6812], 180, { minDistM: 300 });
ok(r.length > 0, `巡回先の候補 ${r.length} 件`);
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
