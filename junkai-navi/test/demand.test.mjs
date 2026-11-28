// TZ=Asia/Tokyo node test/demand.test.mjs — 現在地の印をルートに合わせる・祝日・乗車実績の重み付け
import { EndlessNavigator } from '../js/navcore.js';
import { DemandEngine, expectedRevenueRate } from '../js/demand.js';
import { venueKey, eventWindow, activeVenues, learnWindow, DEFAULT_WIN } from '../js/events.js';
import { readFileSync, existsSync } from 'node:fs';
import { importAnalyzerCsv, decodeCsv } from '../js/csv.js';
import { rideType } from '../js/csv.js';
import { fitModel, timeWeight, nowInfo, prep, pickupRate } from '../js/model.js';
import { isHoliday, isOffDay } from '../js/calendar.js';
import { cumulative, destination, haversine, snapToRoute } from '../js/geo.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };

// ===== 現在地の印はルートの線の上 =====
{
  const start = [135.195, 34.695];
  const coords = [start];
  for (let i = 1; i <= 20; i++) coords.push(destination(coords[i - 1], i <= 10 ? 90 : 0, 50)); // 東へ500m → 北へ500m
  const cum = cumulative(coords);
  const route = { coords, cum, length: cum[cum.length - 1], maneuvers: [] };
  const nav = new EndlessNavigator({ router: {}, demand: new DemandEngine(), now: () => 0, settings: { lookAheadM: 0, lookAheadSec: 0 } });
  nav.tick = () => {}; nav.announce = () => {};
  nav.route = route; nav.onRoute = true;
  let t = 0, worst = 0, worstRaw = 0;
  for (let a = 0; a <= 900; a += 15) {
    // GPS の誤差：道の横へ ±18m 揺らす
    let i = 0; while (i < coords.length - 2 && cum[i + 1] < a) i++;
    const seg = a <= 500 ? 90 : 0;
    const truth = destination(coords[i], seg, a - cum[i]);
    const gps = destination(truth, seg + 90, (a / 15) % 2 ? 18 : -18);
    nav.update({ point: gps, speed: 15, heading: seg, accuracy: 10, t: (t += 1000) });
    const dp = nav.displayPos();
    worst = Math.max(worst, snapToRoute(route, dp.point).dist);
    worstRaw = Math.max(worstRaw, snapToRoute(route, gps).dist);
  }
  ok(worst < 0.5 && worstRaw > 15, `GPSが道の横に${worstRaw.toFixed(0)}mずれても、印はルート上（最大 ${worst.toFixed(2)}m）`);
  const dp = nav.displayPos();
  ok(Math.abs(dp.bearing - 0) < 3 || Math.abs(dp.bearing - 360) < 3, `印の向きはルートの向き（${dp.bearing.toFixed(0)}°）`);
  // ルートから大きく外れたら GPS の位置
  const far = destination(dp.point, 90, 150);
  nav.update({ point: far, speed: 15, heading: 90, accuracy: 10, t: (t += 1000) });
  ok(haversine(nav.displayPos().point, far) < 1 && nav.displayPos().route == null, 'ルートから外れた時は GPS の位置に出す');
}

// ===== 祝日 =====
ok(isHoliday(new Date(2026, 10, 3)) && isHoliday(new Date(2026, 8, 22)) && isHoliday(new Date(2026, 4, 6)), '文化の日・国民の休日（9/22）・振替休日（5/6）');
ok(!isHoliday(new Date(2026, 10, 4)) && isOffDay(new Date(2026, 11, 31)) && !isOffDay(new Date(2026, 10, 24)), '平日・年末は休日扱い');

// ===== 乗車実績の重み（カーネル・経験ベイズの縮小） =====
const T = (s) => new Date(s).getTime();
const now = new Date('2026-11-24T10:00:00+09:00');
{
  const nw = nowInfo(now);
  const [r1, r2, r3, r4] = prep([T('2026-11-17T10:20:00+09:00'), T('2026-11-17T15:00:00+09:00'), T('2026-11-03T10:00:00+09:00'), T('2026-11-04T10:00:00+09:00')].map((t) => ({ lng: 135.2, lat: 34.7, t })));
  const near = timeWeight(r1, nw, 60, 1, 0.5), far = timeWeight(r2, nw, 60, 1, 0.5), weak = timeWeight(r2, nw, 60, 1 / 9, 0.5);
  ok(near > 5 * far && far < 0.1, `時刻が近い乗車ほど重い（20分差 ${near.toFixed(2)}・5時間差 ${far.toFixed(2)}）`);
  ok(weak > 0.8, `近くの乗車が少ない場所は時刻の傾向を弱く使う（5時間差でも ${weak.toFixed(2)}）`);
  ok(timeWeight(r3, nw, 60, 1, 0.5) < timeWeight(r4, nw, 60, 1, 0.5), '祝日の乗車は平日の需要には弱く効く');
}
{
  // 何度も乗せた場所は時刻の傾向を強く：朝ばかりのA（8件）は夜に大きく下がり、1件だけのBはあまり変わらない
  const dm = new DemandEngine();
  const A = [135.19, 34.69], B = [135.25, 34.72];
  for (let d = 10; d < 18; d++) dm.csvRides.push({ lng: A[0], lat: A[1], t: T(`2026-11-${d}T08:00:00+09:00`), name: 'A' });
  dm.csvRides.push({ lng: B[0], lat: B[1], t: T('2026-11-12T08:00:00+09:00'), name: 'B' });
  const sc = (when) => { dm.areas = new Map(); dm.update(new Date(when), 1); const m = {}; for (const a of dm.areas.values()) m[a.name] = a.score; return m; };
  const am = sc('2026-11-24T08:00:00+09:00'), pm = sc('2026-11-24T22:00:00+09:00');
  ok(am.A > am.B, '朝は朝に何度も乗せた場所が上');
  ok(pm.A / am.A < 0.8 && pm.B / am.B > 0.9, `夜の下がり方：何度も乗せたA ${(pm.A / am.A).toFixed(2)}倍・1件だけのB ${(pm.B / am.B).toFixed(2)}倍`);
}
{
  // まわりにも乗車がある所（面の需要）を高く見る（場所のカーネル密度）
  const dm = new DemandEngine();
  const t = T('2026-11-17T10:00:00+09:00');
  const cl = [135.1825, 34.6890];
  dm.csvRides.push({ lng: 135.30, lat: 34.73, t, name: '単独' });
  dm.csvRides.push({ lng: cl[0], lat: cl[1], t, name: '集まり' }, { lng: cl[0] + 0.0035, lat: cl[1], t, name: '隣' });
  dm.update(now, 1);
  const s = (n) => [...dm.areas.values()].find((a) => a.name === n).score;
  ok(s('集まり') > s('単独'), `まわりにも乗車があるエリアは高く（${s('集まり').toFixed(2)} > ${s('単独').toFixed(2)}）`);
}

// ===== 設定を営業ログの交差検証で選ぶ =====
{
  // 時刻の傾向がはっきりしたデータ：A は毎朝、B は毎晩（20日分）
  const rnd = ((x) => () => (x = (x * 16807) % 2147483647) / 2147483647)(7);
  const A = [135.19, 34.69], B = [135.21, 34.70];
  const jit = (p) => ({ lng: p[0] + (rnd() - 0.5) * 0.002, lat: p[1] + (rnd() - 0.5) * 0.002 });
  const rides = [];
  for (let d = 1; d <= 20; d++) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    for (let k = 0; k < 3; k++) rides.push({ ...jit(A), t: T(`${day}T08:${10 + k * 10}:00+09:00`) });
    for (let k = 0; k < 3; k++) rides.push({ ...jit(B), t: T(`${day}T21:${10 + k * 10}:00+09:00`) });
  }
  const m = fitModel(rides);
  ok(m.fitted && m.gainTime > 1.5, `時刻の傾向があるデータ：時刻を使うと当たる確率 ${m.gainTime.toFixed(2)}倍（幅 ${m.params.hs}m・${m.params.st}分・K=${m.params.K}）`);
  // 同じ場所で時刻がばらばらのデータ：時刻を使っても当たりやすくならない
  const flat = rides.map((r, i) => ({ ...r, t: r.t - (r.t % 864e5) + Math.floor(rnd() * 864e5) }));
  const m2 = fitModel(flat);
  ok(m2.fitted && m2.gainTime < 1.15, `時刻の傾向がないデータ：${m2.gainTime.toFixed(2)}倍（時刻をあまり使わない設定を選ぶ）`);
  ok(!fitModel(rides.slice(0, 6)).fitted, 'データが少ない時は初期値');
  ok(Math.abs(pickupRate([{ kind: '流し' }, { kind: '流し' }, { kind: '乗り場' }], 120) - 1) < 1e-9, '空車の時間あたりの乗車：2件 ÷ 2時間 = 1件/時（乗り場は除く）');
}

// ===== 行き先の選び方（期待収入 ÷ 時間） =====
{
  const mid = { dens: 1, fare: 1 }, dense = { dens: 4, fare: 1 }, rich = { dens: 1, fare: 1.6 };
  ok(expectedRevenueRate(mid, 500, 30, 1) > expectedRevenueRate(mid, 3000, 30, 1), '同じ需要なら近い方');
  ok(expectedRevenueRate(dense, 3000, 120, 1) > expectedRevenueRate(mid, 500, 120, 1), '乗車がまれな時（探す時間が長い）は、少し遠くても需要が4倍の方');
  ok(expectedRevenueRate(mid, 500, 2, 1) > expectedRevenueRate(dense, 6000, 2, 1), '乗車がすぐ見つかる時は、遠い高需要より近い方');
  ok(expectedRevenueRate(rich, 1000, 30, 1) > expectedRevenueRate(mid, 1000, 30, 1), '運賃の高いエリアを高く');
}

// ===== イベント：会場まで乗せた乗車の乗車地を、開演前に需要に =====
{
  ok(venueKey('GLION ARENA KOBE', '兵庫県神戸市中央区新港町130-2') === 'glion' && venueKey('ジーライオンアリーナ神戸', '') === 'glion', '会場名の表記ゆれ（GLION ARENA KOBE／ジーライオンアリーナ神戸）');
  ok(venueKey('国際会館', '京都府京都市左京区岩倉大鷺町') == null && venueKey('コストコ ホールセール 神戸倉庫店', '兵庫県神戸市垂水区') == null, '会場ではない所（京都の国際会館・コストコ）は除く');
  ok(venueKey('神戸国際会館こくさいホール') === 'kih' && venueKey('神戸文化ホール 中ホール') === 'bunka', 'イベント情報の会場名');
  const ev = { date: '2026-11-25', start: '17:00', venue: 'GLION ARENA KOBE', cap: 10000, title: 'ライブ' };
  const at = (hm, d = '2026-11-25') => new Date(`${d}T${hm}:00+09:00`);
  ok(eventWindow(ev, at('15:30')) === 1 && eventWindow(ev, at('12:00')) === 0 && eventWindow(ev, at('15:30', '2026-11-26')) === 0, '開演の2時間半前〜10分前だけ（別の日・早すぎる時間は0）');
  ok(eventWindow(ev, at('14:20')) > 0 && eventWindow(ev, at('14:20')) < 1 && eventWindow(ev, at('17:20')) === 0, '前後はなめらかに・開演後は0');
  ok(Math.abs(activeVenues([ev], at('15:30')).glion.w - Math.sqrt(2)) < 1e-9, '会場の大きさ（1万人は√2倍）');

  // 乗り場からの乗車は使わない（アプリ配車・無線・流しは使う）
  const kinds = [{ kind: '乗り場', app: '' }, { kind: '流し', app: '' }, { kind: '無線', app: '' }, { kind: 'Uber', app: 'Uber' }].map(rideType);
  ok(kinds.join() === 'stand,street,app,app', `乗車の種類：${kinds.join()}`);

  const dm = new DemandEngine();
  const hotel = [135.1935, 34.6935], other = [135.20, 34.70];
  const t0 = T('2026-11-10T15:00:00+09:00');
  dm.csvRides = [{ lng: other[0], lat: other[1], t: t0, name: 'いつもの所' }, { lng: other[0], lat: other[1], t: t0 + 864e5, name: 'いつもの所' }];
  dm.eventRides = [{ lng: hotel[0], lat: hotel[1], name: 'ホテルA', venue: 'glion' }, { lng: hotel[0], lat: hotel[1], name: 'ホテルA', venue: 'glion' }];
  dm.eventFeed = [ev];
  const sc = (when) => { dm.areas = new Map(); dm.update(when, 1); return [...dm.areas.values()].find((a) => a.name === 'ホテルA'); };
  const during = sc(at('15:30')), before = sc(at('11:00'));
  ok(during && during.score > 0 && !before, `開演前はホテルAが需要エリアに（${during && during.score.toFixed(2)}）、イベントの時間でなければ出ない`);
  ok(during && /GLION ARENA KOBEのイベント前/.test(dm.areaName(during)), `案内の名前：${during && dm.areaName(during)}`);
  dm.eventFeed = [{ ...ev, venue: '神戸文化ホール 大ホール' }];
  const otherVenue = sc(at('15:30'));
  ok(otherVenue && otherVenue.score < during.score, '別の会場のイベントでは弱く（3割）');
}

// ===== 乗せる時間帯を営業ログから求める =====
{
  const hist = [{ date: '2026-12-01', start: '17:00', venue: 'GLION ARENA KOBE' }, { date: '2026-12-02', venue: '神戸国際展示場' }];
  const at = (s) => T(`${s}+09:00`);
  ok(JSON.stringify(learnWindow([], hist).win) === JSON.stringify(DEFAULT_WIN), '会場まで乗せた乗車がなければ初期値');
  // 開演17:00の 110〜60分前に乗せた6件
  const rides = [60, 70, 80, 90, 100, 110].map((m) => ({ venue: 'glion', t: at('2026-12-01T17:00:00') - m * 60e3 }));
  const L = learnWindow(rides, hist);
  ok(L.n === 6 && L.median === 85, `開演の何分前に乗せたか：${L.n} 件・真ん中 ${L.median}分前`);
  ok(L.win.lead === 130 && L.win.last === 37, `時間帯は営業ログと初期値を件数で混ぜる：開演の${L.win.lead}分前〜${L.win.last}分前（初期値 150〜10分前）`);
  const ev = { date: '2026-12-08', start: '17:00', venue: 'GLION ARENA KOBE' };
  const t = (hm) => new Date(`2026-12-08T${hm}:00+09:00`);
  ok(eventWindow(ev, t('14:30')) === 1 && eventWindow(ev, t('14:30'), L.win) === 0, '求めた時間帯で需要を出す（14:30は初期値なら対象、営業ログでは早すぎる）');
  ok(eventWindow(ev, t('16:00'), L.win) === 1 && eventWindow(ev, t('16:40'), L.win) < 1, '開演の1時間前は対象・直前は弱く');
  // 別の会場・別の日の乗車は数えない
  ok(learnWindow([{ venue: 'kih', t: at('2026-12-01T16:00:00') }, { venue: 'glion', t: at('2026-12-03T16:00:00') }], hist).n === 0, '同じ日・同じ会場のイベントだけ照らし合わせる');
  // 開演時刻のないイベント（展示会）の日：乗せた時刻から時間帯を
  const L2 = learnWindow([{ venue: 'kccEx', t: at('2026-12-02T08:30:00') }], hist);
  ok(L2.m === 1 && L2.win.dayFrom < DEFAULT_WIN.dayFrom && L2.win.dayTo < DEFAULT_WIN.dayTo, `開演時刻のないイベント：${Math.floor(L2.win.dayFrom / 60)}:${String(L2.win.dayFrom % 60).padStart(2, '0')}〜${Math.floor(L2.win.dayTo / 60)}:${String(L2.win.dayTo % 60).padStart(2, '0')}（初期値 9:00〜12:00）`);
  // 実際の営業ログ × 過去のイベント（あれば）
  const csv = process.env.REAL_CSV, hp = new URL('../../taxi-analyzer/events-history.json', import.meta.url);
  if (csv && existsSync(csv) && existsSync(hp)) {
    const { rides: rr } = importAnalyzerCsv(decodeCsv(readFileSync(csv)));
    const vr = rr.map((r) => ({ ...r, venue: venueKey(r.dropFac, r.dropAddr) })).filter((r) => r.venue && rideType(r) !== 'stand');
    const LR = learnWindow(vr, JSON.parse(readFileSync(hp, 'utf8')).events);
    console.log(`実データ：会場まで乗せた乗車 ${vr.length} 件、開演時刻がわかる ${LR.n} 件、開演時刻のないイベントの日 ${LR.m} 件 → ${JSON.stringify(LR.win)}`);
  }
}

// ===== 候補のエリアの画面（explain）は、行き先の選び方（rank）と同じ判定 =====
{
  const dm = new DemandEngine();
  const o = [135.19, 34.69];
  const P = (b, m, name, n = 3) => { const p = destination(o, b, m); for (let k = 0; k < n; k++) dm.spots.push({ id: name + k, name, lng: p[0], lat: p[1], cat: 'custom' }); return p; };
  P(90, 1500, '東'); P(0, 2500, '北', 6); P(180, 300, '近い'); P(270, 9000, '遠い'); const v = P(45, 2000, '回った');
  dm.update(new Date(T('2026-11-24T10:00:00+09:00')), 1);
  const now = T('2026-11-24T10:00:00+09:00');
  dm.markVisited([...dm.areas.values()].find((a) => a.name === '回った').key, now - 10 * 60e3, v);
  const opts = { center: o, radiusM: 6000, now, revisitMin: 60, pick: 'demand' };
  const r = dm.rank(o, 90, opts), ex = dm.explain(o, 90, opts);
  const on = ex.list.filter((e) => !e.skip);
  ok(on.map((e) => e.area.key).join() === r.map((e) => e.area.key).join(), `候補と順番が行き先の選び方と同じ（${on.map((e) => e.area.name).join('→')}）`);
  const why = Object.fromEntries(ex.list.filter((e) => e.skip).map((e) => [e.area.name, e.skip]));
  ok(why['近い'] === 'near' && why['遠い'] === 'outside' && why['回った'] === 'visited', `候補にしない理由：${JSON.stringify(why)}`);
  const vis = ex.list.find((e) => e.area.name === '回った');
  ok(vis.lastMin === 10, `回ってからの時間：${vis.lastMin}分`);
  const east = ex.list.find((e) => e.area.name === '東');
  ok(east.travelMin > 0 && east.searchMin > 0 && east.area.why && east.area.why.cats.custom === 3, '移動・乗車までの時間と、需要の内訳（登録地点3件）');
}

console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
