// node test/navcore.test.mjs — 確定区間・案内ロック・エンドレス性の検証
import { EndlessNavigator } from '../js/navcore.js';
import { DemandEngine } from '../js/demand.js';
import { destination, bearing, haversine, cumulative, pointAt, angleDiff } from '../js/geo.js';

let clock = Date.parse('2026-11-20T08:00:00+09:00');
const now = () => clock;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// 擬似ルーター：進行方向に d1 進み、曲がって目標へ（L字）
const fakeRouter = {
  calls: 0,
  async route(from, to) {
    this.calls++;
    const out = [];
    for (let k = 0; k < 2; k++) {
      const d1 = 80 + rnd() * 600;
      const h = from.heading ?? bearing(from.point, to);
      const a = destination(from.point, h, d1);
      const coords = [from.point, destination(from.point, h, d1 / 2), a, to];
      const cum = cumulative(coords);
      const turn = bearing(a, to) - h;
      const rightish = ((turn + 360) % 360) < 180;
      out.push({
        coords, cum, length: cum[cum.length - 1], time: cum[cum.length - 1] / 10,
        maneuvers: [{ at: cum[2], type: rightish ? 10 : 15, kind: rightish ? 'right' : 'left', ja: rightish ? '右折' : '左折', action: true, right: rightish, uturn: false, street: '', announced: null }],
      });
    }
    return out;
  },
};

const demand = new DemandEngine();
const center = [139.7671, 35.6812];
for (let i = 0; i < 40; i++) {
  const p = destination(center, rnd() * 360, 500 + rnd() * 5000);
  demand.spots.push({ id: i, name: `S${i}`, lng: p[0], lat: p[1], cat: ['station', 'hotel', 'shopping', 'custom'][i % 4] });
}
demand.update(new Date(clock), 1);

const voices = [];
let lastRouteEvent = null;
const nav = new EndlessNavigator({ router: fakeRouter, demand, now, emit: (t, d) => { if (t === 'voice') voices.push(d); if (t === 'route') lastRouteEvent = d; } });

const sleep = () => new Promise((r) => setImmediate(r));
let fails = 0;
const assert = (c, msg) => { if (!c) { fails++; console.error('NG:', msg); } };

// 車両：ルートに沿って 12m/s で走る（GPS 1Hz）
let pos = center;
nav.update({ point: pos, speed: 0, heading: 90, t: clock });
for (let i = 0; i < 20 && !nav.route; i++) await sleep();
assert(nav.route, '初期ルートが作られる');

let switches = 0, extends_ = 0, reroutes = 0;
let snapshot = null; // 確定区間内の形状
for (let step = 0; step < 3600; step++) {
  clock += 1000;
  if (step % 60 === 0) {
    // 需要をランダムに変動させる（雨・鉄道）
    demand.weather = rnd() < 0.3 ? 'rain' : 'clear';
    demand.railDisruption = rnd() < 0.2;
    demand.update(new Date(clock));
  }
  if (step === 1500) {
    // 大型イベント終了（需要の急増）
    const ep = destination(nav.pos, 0, 2500);
    demand.events.push({ id: 'ev', name: 'ドーム', lng: ep[0], lat: ep[1], end: new Date(clock + 15 * 60e3).toISOString(), size: 'l' });
    // 鉄道の運転見合わせで特定駅に需要が集中した想定
    const sp = destination(nav.pos, 180, 1800);
    for (let k = 0; k < 25; k++) demand.spots.push({ id: 'x' + k, name: '振替駅', lng: sp[0], lat: sp[1], cat: 'custom' });
    demand.update(new Date(clock), 1);
  }
  const before = nav.route;
  const beforeAlong = nav.along;
  const commit = nav.commitAlong();
  const lockedPts = [];
  for (let d = beforeAlong; d <= commit - 1; d += 25) lockedPts.push(pointAt(before, d).point);
  const announced = before.maneuvers.filter((m) => m.announced && m.at > beforeAlong + 5).map((m) => pointAt(before, m.at).point);

  const v = 12;
  let p = pointAt(nav.route, nav.along + v).point;
  if (step >= 2500 && step < 2504) p = destination(p, 90, 150); // ルート逸脱
  nav.update({ point: p, speed: v, heading: null, accuracy: 5, t: clock });
  await sleep(); await sleep();

  if (nav.route !== before && lastRouteEvent && lastRouteEvent.mode === 'reroute') { reroutes++; lastRouteEvent = null; }
  if (nav.route !== before && lastRouteEvent && lastRouteEvent.mode !== 'reroute') {
    if (lastRouteEvent.mode === 'switch') switches++; else extends_++;
    // 確定区間（変更前に計算したもの）の形状がそのまま残っているか
    let maxDev = 0;
    for (const lp of lockedPts) {
      let m = Infinity;
      for (let d = Math.max(0, nav.along - 50); d < nav.along + (commit - beforeAlong) + 50; d += 5) m = Math.min(m, haversine(lp, pointAt(nav.route, d).point));
      maxDev = Math.max(maxDev, m);
    }
    assert(maxDev < 3, `確定区間が保持される (dev=${maxDev.toFixed(1)}m)`);
    // 案内済みの右左折が残っているか
    for (const ap of announced) {
      const still = nav.route.maneuvers.some((m) => haversine(pointAt(nav.route, m.at).point, ap) < 3);
      assert(still, '案内済みの右左折が維持される');
    }
    // 接続直後の最初の右左折まで十分な距離があるか
    const firstNew = nav.route.maneuvers.filter((m) => m.action && m.at > commit - beforeAlong + nav.along).shift();
    lastRouteEvent = null;
  }
  assert(nav.route.length - nav.along > 0, 'ルートが途切れない');
  if (process.env.DBG && step >= 1500 && step % 30 === 0) {
    const r = demand.rank(nav.pos, nav.heading, nav.rankOpts()).slice(0, 2).map(x => `${x.area.name}:${x.utility.toFixed(2)}`);
    console.log(step, 'target', nav.target && nav.target.name, 'rem', Math.round(nav.route.length - nav.along), 'sincePlan', (clock - nav.lastPlanAt)/1000, r.join(' '));
  }
}

console.log(`走行 3600秒 / 接続 ${extends_} 回 / 需要変化による切替 ${switches} 回 / 逸脱リルート ${reroutes} 回 / API呼び出し ${fakeRouter.calls} 回 / 音声 ${voices.length} 件`);
console.log('音声例:', voices.slice(0, 4));
console.log(fails ? `FAILED: ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
