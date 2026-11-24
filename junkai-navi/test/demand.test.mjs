// TZ=Asia/Tokyo node test/demand.test.mjs — 現在地の印をルートに合わせる・祝日・乗車実績の重み付け
import { EndlessNavigator } from '../js/navcore.js';
import { DemandEngine, rideWeight, trendStrength } from '../js/demand.js';
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

// ===== 乗車実績の重み =====
const T = (s) => new Date(s).getTime();
const now = new Date('2026-11-24T10:00:00+09:00');
{
  const near = rideWeight({ t: T('2026-11-17T10:20:00+09:00') }, now, 1);
  const far = rideWeight({ t: T('2026-11-17T15:00:00+09:00') }, now, 1);
  const weak = rideWeight({ t: T('2026-11-17T15:00:00+09:00') }, now, trendStrength(1));
  ok(near > 0.9 && far < 0.05, `時刻が近い乗車ほど重い（20分差 ${near.toFixed(2)}・5時間差 ${far.toFixed(2)}）`);
  ok(weak > 0.8, `1回だけの場所は時刻の傾向を弱く使う（5時間差でも ${weak.toFixed(2)}）`);
  const hol = rideWeight({ t: T('2026-11-03T10:00:00+09:00') }, now, 1), wd = rideWeight({ t: T('2026-11-04T10:00:00+09:00') }, now, 1);
  ok(hol < wd, `祝日の乗車は平日の需要には弱く効く（${hol.toFixed(2)} < ${wd.toFixed(2)}）`);
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
  // 隣のエリアにも乗車がある所（面の需要）を高く見る
  const dm = new DemandEngine();
  const t = T('2026-11-17T10:00:00+09:00');
  const solo = [135.30, 34.73];
  const cl = [135.1825, 34.6890];
  dm.csvRides.push({ lng: solo[0], lat: solo[1], t, name: '単独' });
  dm.csvRides.push({ lng: cl[0], lat: cl[1], t, name: '集まり' }, { lng: cl[0] + 0.005, lat: cl[1], t, name: '隣' });
  dm.update(now, 1);
  const s = (n) => [...dm.areas.values()].find((a) => a.name === n).score;
  ok(s('集まり') > s('単独'), `隣にも乗車があるエリアは高く（${s('集まり').toFixed(2)} > ${s('単独').toFixed(2)}）`);
}

console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
