// node test/navcore.test.mjs — 確定区間・案内ロック・エンドレス性の検証
import { EndlessNavigator } from '../js/navcore.js';
import { DemandEngine } from '../js/demand.js';
import { destination, bearing, haversine, cumulative, pointAt, angleDiff, sampleLine } from '../js/geo.js';

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
let stepModes = [];
const nav = new EndlessNavigator({ router: fakeRouter, demand, now, emit: (t, d) => {
  if (t === 'voice') voices.push(d);
  if (t === 'route') { lastRouteEvent = d; stepModes.push(d.mode); tourSizes.push(d.tour.length); }
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
    // 鉄道の運転見合わせで特定駅に需要が集中した想定
    const sp = destination(nav.pos, 180, 1800);
    for (let k = 0; k < 25; k++) demand.spots.push({ id: 'x' + k, name: '振替駅', lng: sp[0], lat: sp[1], cat: 'custom' });
    demand.update(new Date(clock), 1);
  }
  const before = nav.route;
  stepModes = [];
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
        for (let d = Math.max(0, nav.along - 300); d < nav.along + (before.length - beforeAlong) + 60; d += 5) m = Math.min(m, haversine(ap, pointAt(nav.route, d).point));
        dev = Math.max(dev, m);
      }
      if (dev >= 3 && process.env.DBG2) {
        console.log('DBG step', step, 'modes', stepModes.join(','), 'beforeAlong', Math.round(beforeAlong), 'beforeLen', Math.round(before.length), 'nowAlong', Math.round(nav.along), 'nowLen', Math.round(nav.route.length));
        aheadPts.forEach((ap, k) => { let m = Infinity, at = 0; for (let d = 0; d < nav.route.length; d += 5) { const h = haversine(ap, pointAt(nav.route, d).point); if (h < m) { m = h; at = d; } } if (m > 3 || k < 2) console.log('  pt', k, 'minDist', m.toFixed(1), 'at', at); });
      }
      assert(dev < 3, `先へつなぐ時に走る先のルートが変わらない (dev=${dev.toFixed(1)}m)`);
    }
    // 確定区間（変更前に計算したもの）の形状がそのまま残っているか
    let maxDev = 0;
    for (const lp of lockedPts) {
      let m = Infinity;
      for (let d = Math.max(0, nav.along - 300); d < nav.along + (commit - beforeAlong) + 50; d += 5) m = Math.min(m, haversine(lp, pointAt(nav.route, d).point));
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

// 一直線に並んだ3つの需要エリア：3つとも通るルートになり、順に通過する（最短距離：近い順に足していく）
{
  const d2 = new DemandEngine();
  const o = [135.19, 34.69];
  [800, 1800, 2800].forEach((m, i) => { const p = destination(o, 90, m); d2.spots.push({ id: i, name: `A${i}`, lng: p[0], lat: p[1], cat: 'custom' }); });
  d2.update(new Date(clock), 1);
  const ps = [];
  const n3 = new EndlessNavigator({ router: fakeRouter, demand: d2, now, settings: { pickMode: 'nearest' }, emit: (t, d) => { if (t === 'pass') ps.push(d.name); } });
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

// ===== 需要の高さ優先：通るエリアの組み合わせと順番を、時間あたりの期待収入で決める（再生報酬定理） =====
{
  const o = [135.19, 34.69];
  const mk = (list) => { const d = new DemandEngine(); list.forEach(([name, b, m, n]) => { const p = destination(o, b, m); for (let k = 0; k < n; k++) d.spots.push({ id: `${name}${k}`, name, lng: p[0], lat: p[1], cat: 'custom' }); }); d.update(new Date(clock), 1); return d; };
  const plan = async (dm, settings = {}) => {
    const n = new EndlessNavigator({ router: fakeRouter, demand: dm, now, settings: { pickMode: 'demand', ...settings }, emit: () => {} });
    n.update({ point: o, speed: 0, heading: 90, t: clock });
    for (let i = 0; i < 30 && !n.route; i++) await sleep();
    return n;
  };
  const names = (n) => n.tour.map((x) => x.area.name).join('>');
  // 同じ需要が一直線に3つ：遠くの同じ需要まで行く得は無いので、近い2つを通る（2か所以上が基本）
  const a = await plan(mk([['A0', 90, 800, 3], ['A1', 90, 1800, 3], ['A2', 90, 2800, 3]]));
  assert(names(a) === 'A0>A1', `同じ需要なら、近い2つを順に（${names(a)}）`);
  // 先に需要がずっと高いエリアがあれば、途中を通り抜けてそこへ（途中は乗せられる機会が増えるだけで、ほぼ遠回りにならない）
  const b = await plan(mk([['A0', 90, 800, 3], ['A1', 90, 1800, 3], ['駅', 90, 2800, 40]]));
  assert(b.tour.length >= 2 && b.tour[b.tour.length - 1].area.name === '駅' && b.tour[0].area.name === 'A0', `需要の高いエリアを最後に、途中を通り抜けて（${names(b)}）`);
  // 横に大きく外れたエリア（同じ需要）は、遠回りになるので通らない
  const c = await plan(mk([['A0', 90, 800, 3], ['A1', 90, 1800, 3], ['横', 0, 2400, 3]]));
  assert(!c.tour.some((x) => x.area.name === '横'), `遠回りになるエリアは通らない（${names(c)}）`);
  // 計算したツアーの期待収入
  assert(b.lastOpt && b.lastOpt.v > 0, 'ツアーの期待収入を計算している');
  // 通るエリアの数が1なら1か所
  const d = await plan(mk([['A0', 90, 800, 3], ['A1', 90, 1800, 3]]), { tourMax: 1 });
  assert(d.tour.length === 1, '通るエリアの数を1にすると1か所');
}

// ===== ルート案の選び方：途中の需要・少し前に通った道・運転のしやすさ =====
{
  const o = [135.19, 34.69];
  const mkRoute = (pts, sec, turns = []) => {
    const coords = [];
    for (let i = 0; i < pts.length - 1; i++) { const n = Math.max(1, Math.round(haversine(pts[i], pts[i + 1]) / 25)); for (let k = 0; k < n; k++) coords.push([pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * k) / n, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * k) / n]); }
    coords.push(pts[pts.length - 1]);
    const cum = cumulative(coords);
    return { coords, cum, length: cum[cum.length - 1], time: sec, maneuvers: turns.map((t) => ({ at: t.at, action: true, right: !!t.right, uturn: !!t.uturn, kind: t.right ? 'right' : 'left' })) };
  };
  const dest = destination(o, 90, 2000);
  const north = destination(destination(o, 90, 1000), 0, 600), south = destination(destination(o, 90, 1000), 180, 600);
  const dm = new DemandEngine();
  for (let k = 0; k < 12; k++) dm.spots.push({ id: 'h' + k, name: '北の繁華街', lng: north[0], lat: north[1], cat: 'custom' });
  for (let k = 0; k < 2; k++) dm.spots.push({ id: 'd' + k, name: '行き先', lng: dest[0], lat: dest[1], cat: 'custom' });
  dm.update(new Date(clock), 1);
  dm.searchMin = 30;
  const n = new EndlessNavigator({ router: fakeRouter, demand: dm, now, emit: () => {} });
  n.speed = 0;
  const viaN = mkRoute([o, north, dest], 420, [{ at: 400 }, { at: 1300 }]);
  const viaS = mkRoute([o, south, dest], 420, [{ at: 400 }, { at: 1300 }]);
  assert(n.pickBest([viaS, viaN], true) === viaN, `同じ時間なら、需要の多い道を通る案（途中で乗せる確率 北 ${(n.routeValue(viaN).pEnRoute * 100).toFixed(1)}%・南 ${(n.routeValue(viaS).pEnRoute * 100).toFixed(1)}%）`);
  // 北の繁華街を2分前に通ったばかりなら、待っていた人はもういないので南の案
  const throughN = viaN.coords.filter((p) => haversine(p, north) < 400); // 北の繁華街の中を通る部分
  for (const p of throughN) n.track.push({ p, t: clock - 2 * 60e3 });
  assert(n.pickBest([viaN, viaS], true) === viaS, '少し前に通った道は乗車が起きにくいので、別の案');
  n.track = [];
  // 1時間前に通った道なら、また人が現れている
  for (const p of throughN) n.track.push({ p, t: clock - 60 * 60e3 });
  assert(n.pickBest([viaS, viaN], true) === viaN, '1時間前に通った道なら、また需要の多い道を通る');
  n.track = [];
  // 需要が同じ道なら、右折やUターンの少ない案
  const lefty = mkRoute([o, dest], 400, [{ at: 500 }, { at: 1200 }]);
  const righty = mkRoute([o, dest], 400, [{ at: 500, right: true }, { at: 1200, right: true }]);
  const uturn = mkRoute([o, dest], 380, [{ at: 500, uturn: true }]);
  assert(n.pickBest([righty, uturn, lefty], true) === lefty, '右折・Uターンの少ない案');
  // 大きな遠回りで需要の多い道を通るより、近い案
  const farN = mkRoute([o, destination(north, 0, 2500), dest], 1500, []);
  const direct = mkRoute([o, dest], 400, []);
  assert(n.pickBest([farN, direct], true) === direct, '大きな遠回りになるなら、需要の多い道でも通らない');
}

// ===== 実際の走行で起きること =====
{
  const o = [135.19, 34.69];
  const dg = new DemandEngine();
  [[90, 1500], [0, 2500], [180, 2500]].forEach(([b, m], i) => { const p = destination(o, b, m); dg.spots.push({ id: 'g' + i, name: 'G' + i, lng: p[0], lat: p[1], cat: 'custom' }); });
  dg.update(new Date(clock), 1);
  // ビル街・トンネルで精度の悪い位置が跳んでも、再検索しない
  let badReroutes = 0;
  const ng = new EndlessNavigator({ router: fakeRouter, demand: dg, now, settings: { tourMax: 1 }, emit: (t, d) => { if (t === 'route' && d.mode === 'reroute') badReroutes++; } });
  ng.update({ point: o, speed: 0, heading: 90, t: clock });
  for (let i = 0; i < 30 && !ng.route; i++) await sleep();
  for (let k = 0; k < 6; k++) { clock += 1000; ng.update({ point: destination(pointAt(ng.route, ng.along + 10).point, 0, 200), speed: 10, heading: null, accuracy: 150, t: clock }); await sleep(); }
  assert(badReroutes === 0, `精度の悪い位置（150m）が跳んでも再検索しない（${badReroutes} 回）`);
  // 精度の良い位置で本当に外れたら再検索する。続けて外れても20秒は再検索しない
  let reroutes2 = 0;
  const nr = new EndlessNavigator({ router: fakeRouter, demand: dg, now, settings: { tourMax: 1 }, emit: (t, d) => { if (t === 'route' && d.mode === 'reroute') reroutes2++; } });
  nr.update({ point: o, speed: 0, heading: 90, t: clock });
  for (let i = 0; i < 30 && !nr.route; i++) await sleep();
  for (let k = 0; k < 8; k++) { clock += 1000; nr.update({ point: destination(pointAt(nr.route, nr.along + 10).point, 0, 200), speed: 10, heading: null, accuracy: 8, t: clock }); await sleep(); await sleep(); }
  assert(reroutes2 >= 1 && reroutes2 <= 1, `外れたら計算し直す、12秒以内は繰り返さない（${reroutes2} 回）`);
  // 別の道へ曲がって外れたら、元の行き先へ戻すのではなく、今いる所・進む向きから行き先を選び直す
  {
    const dv = new DemandEngine();
    const P = (b, m, name) => { const p = destination(o, b, m); for (let k = 0; k < 3; k++) dv.spots.push({ id: name + k, name, lng: p[0], lat: p[1], cat: 'custom' }); };
    P(90, 2500, '東'); P(0, 2600, '北');
    dv.update(new Date(clock), 1);
    let rr = 0, voice = '';
    const nd = new EndlessNavigator({ router: fakeRouter, demand: dv, now, settings: { tourMax: 1 }, emit: (t, d) => { if (t === 'route' && d.mode === 'reroute') rr++; if (t === 'voice') voice = d; } });
    nd.update({ point: o, speed: 0, heading: 90, t: clock });
    for (let i = 0; i < 30 && !nd.route; i++) await sleep();
    assert(nd.target && nd.target.name === '東', `最初は進む向き（東）の行き先（${nd.target && nd.target.name}）`);
    // 東へ300m走ってから、北の道へ曲がって走る
    let p = o;
    for (let k = 0; k < 25; k++) { clock += 1000; p = pointAt(nd.route, Math.min(nd.along + 12, nd.route.length)).point; nd.update({ point: p, speed: 12, heading: 90, accuracy: 5, t: clock }); await sleep(); }
    const turnAt = p;
    let offSeen = false;
    for (let k = 1; k <= 8 && rr === 0; k++) { clock += 1000; nd.update({ point: destination(turnAt, 0, 12 * k), speed: 12, heading: 0, accuracy: 5, t: clock }); if (!nd.onRoute) offSeen = true; await sleep(); await sleep(); }
    assert(offSeen && rr === 1, `別の道へ曲がったらすぐ計算し直す（${rr} 回）`);
    for (let i = 0; i < 30 && nd.planning; i++) await sleep();
    assert(nd.target && nd.target.name === '北', `今の向き（北）から行き先を選び直す（${nd.target && nd.target.name}）`);
    assert(/外れました/.test(voice), `読み上げ：${voice}`);
  }
  // ルートサーバーに一時的につながらない：行き先を外さず、待つ時間を延ばし、お知らせは1回
  let down = true, statuses = [];
  const flaky = { calls: 0, async route(...a) { this.calls++; if (down) { const e = new Error('ルートサーバーに接続できません'); e.offline = true; throw e; } return fakeRouter.route(...a); } };
  const nf2 = new EndlessNavigator({ router: flaky, demand: dg, now, settings: { tourMax: 1 }, emit: (t, d) => { if (t === 'status') statuses.push(d); } });
  for (let k = 0; k < 120; k++) { clock += 1000; nf2.update({ point: o, speed: 0, heading: 90, t: clock }); await sleep(); }
  assert(flaky.calls >= 3 && flaky.calls <= 8, `つながらない時は待つ時間を延ばす（2分で ${flaky.calls} 回）`);
  assert(statuses.filter((m) => /つなが|接続/.test(m)).length <= 2, `お知らせを繰り返さない（${statuses.length} 回）`);
  assert(nf2.badTargets.size === 0, 'つながらない時は行き先を外さない');
  down = false;
  for (let k = 0; k < 90 && !nf2.route; k++) { clock += 1000; nf2.update({ point: o, speed: 0, heading: 90, t: clock }); await sleep(); }
  assert(nf2.route, 'つながったら案内を再開する');
}

// ===== 最短距離モード =====
{
  const o = [135.19, 34.69];
  const mk = (list) => { const d = new DemandEngine(); list.forEach(([name, b, m, n], i) => { const p = destination(o, b, m); for (let k = 0; k < n; k++) d.spots.push({ id: `${name}${k}`, name, lng: p[0], lat: p[1], cat: 'custom' }); }); d.update(new Date(clock), 1); return d; };
  const first = async (dm, settings = {}, router = fakeRouter) => {
    const n = new EndlessNavigator({ router, demand: dm, now, settings: { tourMax: 1, pickMode: 'nearest', ...settings }, emit: () => {} });
    n.update({ point: o, speed: 0, heading: 90, t: clock });
    for (let i = 0; i < 30 && !n.route; i++) await sleep();
    return n;
  };
  // 近い（需要そこそこ）と、遠い（需要が高い）
  const dmA = mk([['近い店', 90, 900, 3], ['遠い駅', 90, 3200, 12]]);
  assert((await first(dmA)).target.name === '近い店', '最短距離：需要があれば近いエリアを選ぶ');
  assert((await first(mk([['近い店', 90, 900, 3], ['遠い駅', 90, 3200, 12]]), { pickMode: 'demand' })).target.name === '遠い駅', '需要の高さ優先：需要が高い遠いエリアを選ぶ');
  // 需要がとても小さいエリアは近くても行き先にしない（一番高いエリアの4分の1未満）
  assert((await first(mk([['ほぼ無い', 90, 900, 1], ['遠い駅', 90, 3200, 30]]))).target.name === '遠い駅', '最短距離：需要の小さいエリアは近くても選ばない');
  // 道のりの距離：直線では近いが川の向こう（道のりは遠い）エリアより、道のりが近いエリア
  const matrixRouter = { ...fakeRouter, route: fakeRouter.route.bind(fakeRouter), async matrix(from, targets) { return targets.map((p) => (haversine(o, p) < 1000 ? 5000 : haversine(o, p) * 1.2)); } };
  assert((await first(mk([['川向こう', 90, 800, 3], ['橋のこちら', 80, 1500, 3]]), {}, matrixRouter)).target.name === '橋のこちら', '最短距離：道のりの距離で選ぶ');
  assert((await first(mk([['川向こう', 90, 800, 3], ['橋のこちら', 80, 1500, 3]]), { pickMode: 'demand' }, matrixRouter)).target.name === '橋のこちら', '需要の高さ優先：行き先までの時間も道のりで見る');
  // 走っている位置に合わせて、もっと近い需要エリアが出てきたら切り替える
  const dmS = mk([['先のエリア', 90, 3500, 3]]);
  const ns = new EndlessNavigator({ router: fakeRouter, demand: dmS, now, settings: { tourMax: 1, replanMs: 60000, pickMode: 'nearest' }, emit: () => {} });
  ns.update({ point: o, speed: 0, heading: 90, t: clock });
  for (let i = 0; i < 30 && !ns.route; i++) await sleep();
  const near = destination(destination(o, 90, 1100), 0, 900); // ルートから900m横（今の行き先より近い）
  for (let k = 0; k < 3; k++) dmS.spots.push({ id: 'nn' + k, name: '途中の新しいエリア', lng: near[0], lat: near[1], cat: 'custom' });
  dmS.update(new Date(clock), 1);
  let switched = false;
  for (let s2 = 0; s2 < 120 && !switched; s2++) {
    clock += 1000;
    ns.update({ point: pointAt(ns.route, ns.along + 10).point, speed: 10, heading: null, accuracy: 5, t: clock });
    await sleep(); await sleep();
    if (ns.target && ns.target.name === '途中の新しいエリア') switched = true;
  }
  assert(switched, '走っている位置に合わせて、もっと近い需要エリアに切り替える');
}

// 2か所目が通常の条件（1つ先まで2.5km）より遠くても、複数の候補地を通るルートにする
{
  const d2 = new DemandEngine();
  const o = [135.19, 34.69];
  [[90, 900], [90, 4200]].forEach(([b, m], i) => { const p = destination(o, b, m); d2.spots.push({ id: i, name: `Q${i}`, lng: p[0], lat: p[1], cat: 'custom' }); });
  d2.update(new Date(clock), 1);
  const nq = new EndlessNavigator({ router: fakeRouter, demand: d2, now, emit: () => {} });
  nq.update({ point: o, speed: 0, heading: 90, t: clock });
  for (let i = 0; i < 20 && !nq.route; i++) await sleep();
  assert(nq.tour.length === 2, `候補地が離れていても2か所を通る: ${nq.tour.map((x) => x.area.name).join('>')}`);
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

// ===== 計算中に休止・再開しても止まらない（「Cannot destructure property 'coords' of 'route' as it is null」の再発防止） =====
{
  const unhandled = [];
  const onRej = (e) => unhandled.push(e && e.message);
  process.on('unhandledRejection', onRej);
  const o = [135.19, 34.69];
  const dp = new DemandEngine();
  [[90, 2500], [0, 2500], [180, 2500]].forEach(([b, m], i) => { const p = destination(o, b, m); dp.spots.push({ id: 'p' + i, name: 'P' + i, lng: p[0], lat: p[1], cat: 'custom' }); });
  dp.update(new Date(clock), 1);
  let slow = 0;
  const slowRouter = { ...fakeRouter, route: async (...a) => { for (let i = 0; i < slow; i++) await sleep(); return fakeRouter.route(...a); } };
  const run = async (interrupt) => {
    const n = new EndlessNavigator({ router: slowRouter, demand: dp, now, settings: { tourMax: 1 }, emit: () => {} });
    slow = 0;
    n.update({ point: o, speed: 0, heading: 90, t: clock });
    for (let i = 0; i < 30 && !n.route; i++) await sleep();
    slow = 20;
    n.along = n.route.length - 100; // ルートの終わり近く → 先へつなぐ計算が始まる
    n.update({ point: pointAt(n.route, n.along).point, speed: 10, heading: 90, accuracy: 5, t: (clock += 1000) });
    const planning = n.planning;
    interrupt(n);
    for (let i = 0; i < 60; i++) await sleep();
    return { n, planning };
  };
  // 休止
  const a = await run((n) => n.pause());
  assert(a.planning && a.n.route == null, '先へつなぐ計算中に休止したら、届いたルートは使わない');
  // 休止してすぐ再開（reset して今いる所から計算し直す）
  slow = 0;
  const b = await run((n) => { n.pause(); n.reset(); slow = 0; n.update({ point: o, speed: 0, heading: 90, t: (clock += 1000) }); });
  for (let i = 0; i < 30 && !b.n.route; i++) await sleep();
  assert(b.n.route && !b.n.planning, '計算中に再開しても、新しいルートで案内を続ける');
  // 以前の休止のしかた（ルートを直接消す）でも落ちない
  await run((n) => { n.route = null; n.target = null; n.tour = []; });
  assert(unhandled.length === 0, `計算中に休止・再開してもエラーにならない（${unhandled.join(' / ') || 'エラーなし'}）`);
  process.off('unhandledRejection', onRej);
}

console.log(`走行 3600秒 / 接続 ${extends_} 回 / 需要変化による切替 ${switches} 回 / 逸脱リルート ${reroutes} 回 / API呼び出し ${fakeRouter.calls} 回 / 音声 ${voices.length} 件`);
console.log('音声例:', voices.slice(0, 4));
console.log(fails ? `FAILED: ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
