// TZ=Asia/Tokyo node test/profile.test.mjs — 登録地点の時間帯・曜日（営業ログからの自動、自分で指定）と需要
import { readFileSync } from 'node:fs';
import { profFactor, parseHours, parseDays, manualProf, logProf, profText } from '../js/profile.js';
import { csvToPlaces, placesToCsv, mergePlaces } from '../js/places.js';
import { DemandEngine } from '../js/demand.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m); // 2026/11/d（11/23=月、11/28=土、11/29=日）

// 時間帯・曜日の読み取り
const hs = (f) => f.map((v, i) => (v ? i : null)).filter((v) => v != null).join(',');
ok(hs(parseHours('7-10')) === '7,8,9', '7-10 は 7〜9時台');
ok(hs(parseHours('22〜2時')) === '0,1,22,23', '日をまたぐ 22-2');
ok(parseHours('') === null && parseDays('') === null && parseDays('毎日') === null, '空・毎日は指定なし');
ok(parseDays('平日').join('') === '0111110' && parseDays('土日').join('') === '1000001', '平日・土日');

// 自分で指定：金土の22-2時
const night = manualProf(parseHours('22-2'), parseDays('金土'));
ok(profText(night) === '22-2時 / 金土', `表示: ${profText(night)}`);
ok(profFactor(night, at(27, 23)) === 1 && profFactor(night, at(23, 23)) < 0.1 && profFactor(night, at(27, 12)) < 0.1, '金曜23時は需要あり、月曜23時・金曜昼は低い');

// 営業ログから：平日の朝8時台に多い（回数が多いほど傾向をはっきり）
const morning = logProf([23, 24, 25, 26, 27, 23, 24, 25].map((d, i) => at(d, 8, i * 5).getTime()));
ok(profFactor(morning, at(24, 8, 30)) > 0.8, `平日8時台は高い ${profFactor(morning, at(24, 8, 30)).toFixed(2)}`);
ok(profFactor(morning, at(24, 22)) < 0.3, `平日22時は低い ${profFactor(morning, at(24, 22)).toFixed(2)}`);
ok(profFactor(morning, at(29, 8, 30)) < profFactor(morning, at(24, 8, 30)) * 0.7, '日曜の朝は平日の朝より低い');
const once = logProf([at(24, 10).getTime()]);
ok(profFactor(once, at(24, 22)) > 0.3, '1回だけの乗車では他の時間を0にしない');

// 営業ログの読み込みで、乗車した場所ごとに時刻・曜日の傾向を持つ
const head = '日時,営業日,種別,ステータス,備考,運賃合計,運賃,迎車料金,アプリ手数料,取扱手数料,遠距離割,障害者割,高速代,迎車なし,決済方法,チケットの種類,乗車種別,配車アプリ,乗車時刻,乗車施設,乗車住所,乗車住所の入力,乗車緯度,乗車経度,降車施設,降車住所,降車住所の入力,降車緯度,降車経度';
const row = (ts, fac, addr) => [ts, ts.slice(0, 10), '乗車記録', '実車', '', 1600, 1600, 0, 0, '', '', '', '', '', '現金', '', '流し', '', ts, fac, addr, '施設', '', '', '', '', '', '', ''].join(',');
const lines = [head];
for (const d of [23, 24, 25, 26, 27]) lines.push(row(`2026/11/${d} 08:15:00`, '朝の駅（施設）', '兵庫県神戸市中央区A町1'));
for (const d of [27, 28]) lines.push(row(`2026/11/${d} 23:30:00`, '夜の繁華街（施設）', '兵庫県神戸市中央区B町2'));
const { items } = csvToPlaces('﻿' + lines.join('\r\n'));
const st = items.find((x) => x.name === '朝の駅'), nl = items.find((x) => x.name === '夜の繁華街');
ok(st.prof && st.prof.src === 'log' && st.prof.h[8] === 5, `営業ログ → 時間帯の傾向 ${profText(st.prof)}`);
ok(/23-24時/.test(profText(nl.prof)) && /金土/.test(profText(nl.prof)), `夜の場所 ${profText(nl.prof)}`);

// CSV の書き出し → 読み込み（時間帯・曜日の列）
const csv = placesToCsv([{ id: 'a', name: '夜の店', addr: 'x', kind: 'custom', lat: 34.69, lng: 135.19, prof: night }]);
ok(/時間帯,曜日/.test(csv) && /22-2時,金土/.test(csv), 'CSVに時間帯・曜日の列');
const back = csvToPlaces(csv).items[0];
ok(back.prof && profFactor(back.prof, at(27, 23)) === 1 && profFactor(back.prof, at(23, 23)) < 0.1, 'CSVから時間帯・曜日を読み込める');

// 読み込み直しても、自分で指定した時間帯・曜日は消さない
const mine = [{ id: 'm', name: '朝の駅', addr: '兵庫県神戸市中央区A町1', kind: 'custom', lat: 1, lng: 1, rides: 5, prof: night }];
const mr = mergePlaces(mine, [{ ...st, lat: 1, lng: 1 }]);
ok(mr.list[0].prof.src === 'manual', '自分で指定した時間帯・曜日は営業ログで上書きしない');

// 需要：平日の朝は「朝の駅」、金曜の深夜は「夜の繁華街」が上位
const dm = new DemandEngine();
dm.spots = [{ ...st, id: 's', lat: 34.69, lng: 135.19, cat: 'custom' }, { ...nl, id: 'n', lat: 34.70, lng: 135.20, cat: 'custom' }];
const top = (date) => { dm.areas = new Map(); dm.update(date, 1); return [...dm.areas.values()].sort((a, b) => b.score - a.score)[0].name; };
ok(top(at(24, 8, 20)) === '朝の駅', `火曜8時の最上位: ${top(at(24, 8, 20))}`);
ok(top(at(27, 23, 40)) === '夜の繁華街', `金曜23時の最上位: ${top(at(27, 23, 40))}`);

// 実データ（あれば）
if (process.env.REAL_CSV) {
  const r = csvToPlaces(readFileSync(process.env.REAL_CSV, 'utf8'), { kinds: { street: true, stand: true, app: false } }).items;
  console.log('実データ：', r.slice(0, 4).map((x) => `${x.name}(${x.rides}回) ${profText(x.prof)}`).join(' ／ '));
}
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
