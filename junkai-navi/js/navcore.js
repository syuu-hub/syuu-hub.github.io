// エンドレス巡回ナビの中核
// ・確定区間（commit）より手前のルートは絶対に変えない
// ・新ルートは確定区間の終点から、進行方向を保ったまま接続する
// ・案内済みの右左折はロック
// ・需要の小さな変化では切り替えない（ヒステリシス＋最小間隔）
import { haversine, bearing, cumulative, snapToRoute, pointAt, sliceRoute, sampleLine } from './geo.js?v=8';

export const DEFAULTS = {
  commitSec: 30, // 確定区間（秒）
  commitMinM: 300, // 確定区間の最小距離
  minFirstTurnSec: 10, // 接続直後の最初の右左折までの最小余裕
  minFirstTurnM: 150,
  extendMinM: 900, // 残りがこれ以下（または90秒以下）になったら次の区間を接続
  replanMs: 180000, // 需要変化による切替の最小間隔
  switchGain: 1.3, // 切替に必要な需要の改善倍率
  offRouteM: 45,
  radiusM: 6000,
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function voiceDistance(m) {
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toFixed(1).replace('.0', '')}キロ`;
  if (m >= 100) return `${Math.round(m / 50) * 50}メートル`;
  return `${Math.max(10, Math.round(m / 10) * 10)}メートル`;
}

export class EndlessNavigator {
  constructor({ router, demand, settings = {}, emit = () => {}, now = () => Date.now() }) {
    this.router = router;
    this.demand = demand;
    this.s = { ...DEFAULTS, ...settings };
    this.emit = emit;
    this.now = now;
    this.reset();
  }

  reset() {
    this.route = null;
    this.along = 0;
    this.pos = null;
    this.speed = 0;
    this.heading = null;
    this.target = null;
    this.planning = false;
    this.lastPlanAt = 0;
    this.nextTryAt = 0;
    this.offCount = 0;
    this.track = [];
    this.badTargets = new Map();
    this.serviceCenter = null;
  }

  // ===== 位置更新 =====
  update(fix) {
    const t = fix.t || this.now();
    const prev = this.track[this.track.length - 1];
    if (prev && haversine(prev.p, fix.point) < 3 && fix.speed == null) return;
    // 速度・方位の推定
    if (fix.speed != null && fix.speed >= 0) this.speed = fix.speed;
    else if (prev) this.speed = haversine(prev.p, fix.point) / Math.max(0.5, (t - prev.t) / 1000);
    if (fix.heading != null && !Number.isNaN(fix.heading) && this.speed > 1.5) this.heading = fix.heading;
    else if (prev && haversine(prev.p, fix.point) > 5) this.heading = bearing(prev.p, fix.point);
    this.pos = fix.point;
    if (!this.serviceCenter) this.serviceCenter = fix.point;
    this.track.push({ p: fix.point, t });
    while (this.track.length && t - this.track[0].t > 20 * 60e3) this.track.shift();

    if (this.route) {
      const snap = snapToRoute(this.route, fix.point, this.along);
      const acc = fix.accuracy == null ? 10 : fix.accuracy;
      if (snap.dist > Math.max(this.s.offRouteM, acc * 1.2)) this.offCount++;
      else { this.offCount = 0; this.along = Math.max(this.along - 20, snap.along); }
      this.snapDist = snap.dist;
      if (this.offCount >= 3 && !this.planning) {
        this.offCount = 0;
        this.emit('voice', 'ルートを再検索します');
        this.plan('reroute');
        return;
      }
      this.announce();
    }
    this.tick();
  }

  // ===== 音声案内 =====
  nextActions() {
    if (!this.route) return [];
    return this.route.maneuvers.filter((m) => m.action && m.at > this.along + 5);
  }

  announce() {
    const [next, then] = this.nextActions();
    if (!next) return;
    const dist = next.at - this.along;
    const v = Math.max(this.speed, 5);
    const farTh = clamp(v * 25, 250, 800);
    const nearTh = clamp(v * 7, 60, 150);
    const street = next.street ? `、${next.street}方面` : '';
    if (!next.announced && dist <= farTh && dist > nearTh + 40) {
      next.announced = 'far';
      this.emit('voice', `およそ${voiceDistance(dist)}先、${next.ja}です${street}`);
    } else if (next.announced !== 'near' && dist <= nearTh) {
      next.announced = 'near';
      let msg = `まもなく${next.ja}です${street}`;
      if (then && then.at - next.at < 120) {
        msg += `。その先すぐ${then.ja}です`;
        if (!then.announced) then.announced = 'far';
      }
      this.emit('voice', msg);
    }
  }

  // ===== 確定区間 =====
  commitAlong() {
    let c = this.along + Math.max(this.s.commitMinM, this.speed * this.s.commitSec);
    for (const m of this.route.maneuvers) {
      if (m.announced && m.at >= this.along - 5) c = Math.max(c, m.at + 40);
    }
    return Math.min(c, this.route.length - 1);
  }

  // ===== 計画 =====
  tick() {
    if (this.planning || this.now() < this.nextTryAt || !this.pos) return;
    if (!this.route) return void this.plan('initial');
    const remaining = this.route.length - this.along;
    if (remaining < Math.max(this.s.extendMinM, this.speed * 90)) return void this.plan('extend');
    if (this.now() - this.lastPlanAt > this.s.replanMs && this.target) {
      const c = this.commitAlong();
      const start = pointAt(this.route, c);
      const ranked = this.rankFrom(start.point, start.bearing);
      const best = ranked[0];
      if (best && best.area.key !== this.target.key) {
        const cur = this.demand.utilityOf(this.target.key, start.point, start.bearing, this.rankOpts());
        if (best.utility >= cur * this.s.switchGain) return void this.plan('switch', [best.area]);
      }
      this.lastPlanAt = this.now(); // 切替不要 → 次回チェックまで待つ
    }
  }

  rankOpts() {
    const now = this.now();
    const exclude = new Set();
    for (const [k, until] of this.badTargets) if (until > now) exclude.add(k);
    return { center: this.serviceCenter, radiusM: this.s.radiusM, exclude, now };
  }

  rankFrom(point, heading) {
    let r = this.demand.rank(point, heading, this.rankOpts());
    if (!r.length) r = this.demand.rank(point, heading, { ...this.rankOpts(), center: null, minDistM: 300 });
    return r;
  }

  async plan(mode, preferred = null) {
    if (this.planning) return;
    this.planning = true;
    try {
      let start, commit = null;
      const relaxed = mode === 'initial' || mode === 'reroute';
      if (relaxed) {
        start = { point: this.pos, bearing: this.heading };
      } else {
        commit = this.commitAlong();
        start = pointAt(this.route, commit);
      }
      let targets = preferred;
      if (!targets) {
        const exclude = mode === 'extend' && this.target ? this.target.key : null;
        targets = this.rankFrom(start.point, start.bearing)
          .filter((x) => x.area.key !== exclude)
          .slice(0, 3)
          .map((x) => x.area);
        if (mode === 'reroute' && this.target) targets = [this.target, ...targets];
      }
      if (!targets.length) {
        this.emit('status', '周辺に需要エリアがありません。設定で需要スポットを取得してください');
        this.nextTryAt = this.now() + 15000;
        return;
      }
      for (const target of targets.slice(0, 2)) {
        let routes;
        try {
          routes = await this.router.route({ point: start.point, heading: start.bearing }, target.center);
        } catch (e) {
          this.badTargets.set(target.key, this.now() + 10 * 60e3);
          this.emit('status', e.message);
          continue;
        }
        // 応答待ちの間に確定区間の終点を通り過ぎていたら破棄
        if (commit != null && this.along > commit - 30) break;
        const remaining = this.route ? this.route.length - this.along : Infinity;
        const best = this.pickBest(routes, relaxed || remaining < 250);
        if (!best) continue;
        this.apply(mode, target, best, commit);
        return;
      }
      this.nextTryAt = this.now() + 5000;
    } finally {
      this.planning = false;
    }
  }

  // 慌ただしい操作にならない候補を選ぶ
  pickBest(routes, relaxed) {
    const v = Math.max(this.speed, 5);
    const minGap = Math.max(this.s.minFirstTurnM, v * this.s.minFirstTurnSec);
    const trackSet = this.trackGrid();
    let best = null;
    for (const r of routes) {
      const acts = r.maneuvers.filter((m) => m.action);
      if (!relaxed && acts.length && acts[0].at < minGap) continue;
      let cost = r.time;
      cost += acts.length * 15;
      cost += acts.filter((m) => m.right).length * 20; // 左側通行：右折は重め
      cost += acts.filter((m) => m.uturn).length * 400;
      for (let i = 1; i < acts.length; i++) if (acts[i].at - acts[i - 1].at < 100) cost += 60; // 連続右左折
      // 直近20分に走った道との重なり
      const samples = sampleLine(r.coords, 50);
      let hit = 0;
      for (const p of samples) if (trackSet.has(gridKey(p))) hit++;
      cost += (hit / Math.max(1, samples.length)) * 600;
      if (!best || cost < best.cost) best = { route: r, cost };
    }
    return best && best.route;
  }

  trackGrid() {
    const s = new Set();
    for (const { p } of this.track) s.add(gridKey(p));
    return s;
  }

  apply(mode, target, newRoute, commit) {
    if (mode === 'extend' && this.target) this.demand.markVisited(this.target.key, this.now());
    if (commit == null) {
      this.route = newRoute;
      this.along = 0;
      if (this.pos) this.along = snapToRoute(newRoute, this.pos).along;
    } else {
      const keepFrom = Math.max(0, this.along - 300);
      this.route = stitch(this.route, keepFrom, commit, newRoute);
      this.along -= keepFrom;
    }
    this.target = target;
    this.lastPlanAt = this.now();
    this.emit('route', { mode, target, route: this.route });
  }

  // ===== UI用 =====
  view() {
    if (!this.route) return null;
    const [next, then] = this.nextActions();
    const remaining = this.route.length - this.along;
    return {
      next,
      nextDist: next ? next.at - this.along : remaining,
      then: then && next && then.at - next.at < 300 ? then : null,
      target: this.target,
      remaining,
      eta: remaining / Math.max(this.speed, 6),
      commitAlong: this.commitAlong(),
    };
  }
}

const gridKey = (p) => `${Math.round(p[1] / 0.0003)}:${Math.round(p[0] / 0.00037)}`;

// 既存ルートの [keepFrom, commit] に新ルートを接続
export function stitch(route, keepFrom, commit, next) {
  const prefix = sliceRoute(route, keepFrom, commit);
  const coords = prefix.concat(next.coords);
  const cum = cumulative(coords);
  const base = cum[prefix.length];
  const maneuvers = [];
  for (const m of route.maneuvers) if (m.at >= keepFrom && m.at < commit) maneuvers.push({ ...m, at: m.at - keepFrom });
  for (const m of next.maneuvers) maneuvers.push({ ...m, at: m.at + base });
  return { coords, cum, length: cum[cum.length - 1], time: next.time, maneuvers };
}
