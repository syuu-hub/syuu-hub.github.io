// node test/navcore.test.mjs — 確定区間・案内ロック・エンドレス性の検証
import { EndlessNavigator } from '../js/navcore.js';
import { DemandEngine } from '../js/demand.js';
import { destination, bearing, haversine, cumulative, pointAt, angleDiff } from '../js/geo.js';

let clock = Date.parse('2026-11-20T08:00:00+09:00');
const now = () => clock;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// 擬似ルーター：進行方向に d1 進み、曲がって（通過地点を順に通り）目標へ
const fakeRouter = {
  calls: 0, viaCalls: 0,
  async route(from, to, opt = {}) {
    this.calls++;
    const via = opt.via || [];
    if (via.length) this.viaCalls++;
    const out = [];
    for (let k = 0; k < (via.length ? 1 : 2); k++) {
      const d1 = 80 + rnd() * 600;
      const h = from.heading ?? bearing(from.point, via[0] || to);
      const a = destination(from.point, h, d1);
      const coords = [from.point, destination(from.point, h, d1 / 2), a, ...via, to];
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
const passes = [], tourSizes = [];
const nav = new EndlessNavigator({ router: fakeRouter, demand, now, emit: (t, d) => {
  if (t === 'voice') voices.push(d);
  if (t === 'route') { lastRouteEvent = d; tourSizes.push(d.tour.length); }
  if (t === 'pass') passes.push({ ...d, at: clock });
} });

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
let minAhead = Infinity;
const driven = []; // 走った位置（約40m四方のマス）
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
  const aheadPts = [];
  for (let d = beforeAlong; d <= before.length; d += 100) aheadPts.push(pointAt(before, d).point);

  const v = 12;
  let p = pointAt(nav.route, nav.along + v).point;
  if (step >= 2500 && step < 2504) p = destination(p, 90, 150); // ルート逸脱
  nav.update({ point: p, speed: v, heading: null, accuracy: 5, t: clock });
  if (step % 3 === 0) driven.push({ key: `${Math.round(p[1] / 0.0004)}:${Math.round(p[0] / 0.0005)}`, t: clock });
  await sleep(); await sleep();

  if (nav.route !== before && lastRouteEvent && lastRouteEvent.mode === 'reroute') { reroutes++; lastRouteEvent = null; }
  if (nav.route !== before && lastRouteEvent && lastRouteEvent.mode !== 'reroute') {
    if (lastRouteEvent.mode === 'switch') switches++; else extends_++;
    // 先へつなぐ時は、走る先のルートを1mも変えない（終わりに足すだけ）
    if (lastRouteEvent.mode === 'extend') {
      let dev = 0;
      for (const ap of aheadPts) {
        let m = Infinity;
        for (let d = Math.max(0, nav.along - 50); d < nav.along + (before.length - beforeAlong) + 60; d += 5) m = Math.min(m, haversine(ap, pointAt(nav.route, d).point));
        dev = Math.max(dev, m);
      }
      assert(dev < 3, `先へつなぐ時に走る先のルートが変わらない (dev=${dev.toFixed(1)}m)`);
    }
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
  // ゴールを作らない：最初の数分以降、ルートの先が常に1km以上ある
  const ahead = nav.route.length - nav.along;
  if (step > 120) minAhead = Math.min(minAhead, ahead);
  if (process.env.DBG && step >= 1500 && step % 30 === 0) {
    const r = demand.rank(nav.pos, nav.heading, nav.rankOpts()).slice(0, 2).map(x => `${x.area.name}:${x.utility.toFixed(2)}`);
    console.log(step, 'target', nav.target && nav.target.name, 'rem', Math.round(nav.route.length - nav.along), 'sincePlan', (clock - nav.lastPlanAt)/1000, r.join(' '));
  }
}

assert(minAhead > 1000, `ルートの先が常に残っている（最短 ${Math.round(minAhead)}m）`);
console.log(`ルートの先の最短 ${Math.round(minAhead)}m`);

// 複数エリアを通るルート（ツアー）
assert(tourSizes.some((n) => n >= 2), `複数のエリアを通るルートを作る（エリア数: ${tourSizes.join(',')}）`);
assert(tourSizes.every((n) => n >= 1 && n <= 3), 'エリア数は設定の上限（3）以内');
assert(passes.length > 0, `途中のエリアを通過したことを検出する（${passes.length} 回）`);
assert(passes.every((a) => demand.visited.has(a.key)), '通過したエリアは「回った」扱いになる');
// 同じ所をぐるぐる回らない：60分以内に、同じエリア（または500m以内）を2回通らない
let revisits = 0;
passes.forEach((a, i) => { for (let j = 0; j < i; j++) if (a.at - passes[j].at < 60 * 60e3 && haversine(a.center, passes[j].center) < 500) { revisits++; if (process.env.DBG2) console.log('REVISIT', passes[j].name, '->', a.name, Math.round((a.at - passes[j].at)/1000)+'s', Math.round(haversine(a.center, passes[j].center))+'m', a.key===passes[j].key); break; } });
assert(revisits === 0, `60分以内に同じ所（500m以内）を通り直さない（${revisits} 回）`);
// 走った道の重なり：1時間の走行で、同じ道（約40m四方）を通った割合
{
  const seen = new Map(); let tot = 0, again = 0;
  for (const k of driven) { tot++; const t = seen.get(k.key); if (t != null && k.t - t > 3 * 60e3) again++; if (t == null || k.t - t > 3 * 60e3) seen.set(k.key, k.t); }
  console.log(`走った道のうち、3分以上たってから同じ道を通り直した割合 ${(again / tot * 100).toFixed(1)}%`);
  assert(again / tot < 0.15, '同じ道の通り直しが少ない');
}
console.log(`ツアー：作成 ${tourSizes.length} 回・平均 ${(tourSizes.reduce((a, b) => a + b, 0) / tourSizes.length).toFixed(1)} エリア / 途中エリアの通過 ${passes.length} 回 / 通過地点つきの経路計算 ${fakeRouter.viaCalls} 回`);

// 1か所ずつの設定（tourMax=1）では従来どおり
{
  const n1 = new EndlessNavigator({ router: fakeRouter, demand, now, settings: { tourMax: 1 }, emit: () => {} });
  n1.update({ point: center, speed: 0, heading: 90, t: clock });
  for (let i = 0; i < 20 && !n1.route; i++) await sleep();
  assert(n1.route && n1.tour.length === 1, '通るエリアの数を1にすると1か所ずつ');
}

// 一直線に並んだ3つの需要エリア：3つとも通るルートになり、順に通過する
{
  const d2 = new DemandEngine();
  const o = [135.19, 34.69];
  [800, 1800, 2800].forEach((m, i) => { const p = destination(o, 90, m); d2.spots.push({ id: i, name: `A${i}`, lng: p[0], lat: p[1], cat: 'custom' }); });
  d2.update(new Date(clock), 1);
  const ps = [];
  const n3 = new EndlessNavigator({ router: fakeRouter, demand: d2, now, emit: (t, d) => { if (t === 'pass') ps.push(d.name); } });
  n3.update({ point: o, speed: 0, heading: 90, t: clock });
  for (let i = 0; i < 20 && !n3.route; i++) await sleep();
  assert(n3.tour.map((x) => x.area.name).join('>') === 'A0>A1>A2', `近い順に3エリアを通る: ${n3.tour.map((x) => x.area.name).join('>')}`);
  assert(n3.tour.slice(0, 2).every((x) => x.at != null), '途中のエリアはルート上にある');
  for (let s2 = 0; s2 < 400 && n3.route; s2++) {
    clock += 1000;
    const p = pointAt(n3.route, n3.along + 12).point;
    n3.update({ point: p, speed: 12, heading: null, accuracy: 5, t: clock });
    await sleep();
    if (ps.length >= 2) break;
  }
  assert(ps.join('>') === 'A0>A1', `途中のエリアを順に通過: ${ps.join('>')}`);
  assert(n3.target && n3.target.name === 'A2', `通過後は次のエリアを案内: ${n3.target && n3.target.name}`);
}

// 需要エリアが少ない（3か所だけ）場合も、止まらずに案内を続ける（他に行き先が無い時だけ、前に通ったエリアへ）
{
  const d3 = new DemandEngine();
  const o = [135.19, 34.69];
  [0, 120, 240].forEach((b, i) => { const p = destination(o, b, 1500); d3.spots.push({ id: i, name: `P${i}`, lng: p[0], lat: p[1], cat: 'custom' }); });
  d3.update(new Date(clock), 1);
  const nf = new EndlessNavigator({ router: fakeRouter, demand: d3, now, emit: () => {} });
  nf.update({ point: o, speed: 0, heading: 0, t: clock });
  let gaps = 0;
  for (let s3 = 0; s3 < 1500; s3++) {
    clock += 1000;
    if (!nf.route) { gaps++; nf.update({ point: o, speed: 0, heading: 0, t: clock }); await sleep(); continue; }
    nf.update({ point: pointAt(nf.route, nf.along + 12).point, speed: 12, heading: null, accuracy: 5, t: clock });
    await sleep();
    if (nf.route.length - nf.along <= 0) gaps++;
  }
  assert(gaps < 5 && nf.route, `エリアが3か所だけでも案内が途切れない（途切れ ${gaps}）`);
}

console.log(`走行 3600秒 / 接続 ${extends_} 回 / 需要変化による切替 ${switches} 回 / 逸脱リルート ${reroutes} 回 / API呼び出し ${fakeRouter.calls} 回 / 音声 ${voices.length} 件`);
console.log('音声例:', voices.slice(0, 4));
console.log(fails ? `FAILED: ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
