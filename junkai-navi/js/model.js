// 乗車実績からの需要モデル（根拠のある統計の方法で、設定を自分の営業ログから決める）
//
// ■ モデル：乗車は「場所 × 時刻」の上でランダムに起きる（非一様ポアソン過程）と考え、その強さ（乗車密度）を
//   過去の乗車からカーネル密度推定で求める（Silverman 1986）
//   ・場所：ガウスカーネル（幅 hs メートル）
//   ・時刻：1日を円とみなしたガウスカーネル（幅 st 分。23:50 と 0:10 は近い）
//   ・平日／休日（土日・祝日・年末年始）が違う乗車は dayPen だけ弱める
//   ・時刻の傾向の信じ方は経験ベイズの縮小推定：近くの乗車が少ない場所ほど「時刻を問わない平均」に寄せ、
//     多い場所ほど時刻の傾向を使う（重み c = n / (n + K)、n は近くの乗車の数。Efron & Morris 1975 と同じ考え方）
// ■ 設定（hs, st, K, dayPen）は決め打ちせず、営業ログで「1日ずつ抜いて、その日の乗車場所を他の日から当てる」
//   交差検証をして、対数予測スコア（正しい確率予報ほど高くなる、厳密に適正なスコア。Gneiting & Raftery 2007）が
//   一番高い組み合わせを選ぶ
import { isOffDay } from './calendar.js?v=34';

export const DEFAULT_PARAMS = { hs: 250, st: 60, K: 8, dayPen: 0.5 };
export const GRID = { hs: [120, 200, 300, 450, 700], st: [30, 60, 120, 240], K: [1, 3, 8, 20, 60], dayPen: [0, 0.4, 0.8] };
const DAY_MIN = 1440;
const BG = 0.05; // 予報のうち一様分布に回す割合（初めての場所でも確率0にしない、頑健な混合）

// 乗車 → 計算用（平面のメートル座標、時刻・曜日）
export function prep(rides, origin = null) {
  const o = origin || (rides.length ? [rides[0].lng, rides[0].lat] : [0, 0]);
  const kx = 111320 * Math.cos((o[1] * Math.PI) / 180), ky = 110540;
  return rides.map((r) => {
    const d = new Date(r.t);
    return { x: (r.lng - o[0]) * kx, y: (r.lat - o[1]) * ky, tod: d.getHours() * 60 + d.getMinutes(), off: isOffDay(d), day: d.toDateString(), fare: r.fare || 0 };
  });
}
export const toXY = (p, origin) => [(p[0] - origin[0]) * 111320 * Math.cos((origin[1] * Math.PI) / 180), (p[1] - origin[1]) * 110540];

// 時刻 now における乗車 r の重み（時刻のカーネル × 平日／休日、経験ベイズの縮小つき、1日の平均が1になるよう正規化）
export function timeWeight(r, now, st, c, dayPen) {
  const md = Math.abs(r.tod - now.tod) % DAY_MIN;
  const dm = Math.min(md, DAY_MIN - md);
  const g = Math.exp(-(dm * dm) / (2 * st * st));
  const mean = Math.min(1, (st * Math.sqrt(2 * Math.PI)) / DAY_MIN); // 時刻カーネルの1日の平均
  const tw = (1 - c + c * g) / (1 - c + c * mean);
  return r.off === now.off ? tw : tw * (1 - dayPen * c);
}
export const nowInfo = (date) => ({ tod: date.getHours() * 60 + date.getMinutes(), off: isOffDay(date) });

// 各乗車の近くの乗車の数（場所のカーネルで数える。自分も含む）
export function localCounts(P, hs) {
  const out = new Float64Array(P.length);
  const lim = (3 * hs) ** 2;
  for (let i = 0; i < P.length; i++) {
    let n = 0;
    for (let j = 0; j < P.length; j++) {
      const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy;
      if (d2 < lim) n += Math.exp(-d2 / (2 * hs * hs));
    }
    out[i] = n;
  }
  return out;
}

// 交差検証で設定を選ぶ。戻り値：{ params, fitted, n, days, score, scoreNoTime, gainTime }
//   score：1件あたりの対数予測スコア、gainTime：時刻を使うことで、実際の乗車場所に付く確率が何倍になったか
export function fitModel(rides, grid = GRID) {
  const P = prep(rides);
  const days = [...new Set(P.map((p) => p.day))];
  if (P.length < 12 || days.length < 4) return { params: { ...DEFAULT_PARAMS }, fitted: false, n: P.length, days: days.length };
  // 一様分布の面積：乗車のある範囲（＋1km）
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const area = (Math.max(...xs) - Math.min(...xs) + 2000) * (Math.max(...ys) - Math.min(...ys) + 2000);
  const folds = days.map((d) => ({ test: P.map((p, i) => (p.day === d ? i : -1)).filter((i) => i >= 0), train: P.map((p, i) => (p.day !== d ? i : -1)).filter((i) => i >= 0) }));
  const combos = [];
  for (const st of grid.st) for (const K of grid.K) for (const dayPen of grid.dayPen) combos.push({ st, K, dayPen });
  let best = null, bestNoTime = -Infinity;
  for (const hs of grid.hs) {
    const sums = new Float64Array(combos.length + 1); // 最後は「時刻を使わない」
    const norm = 1 / (2 * Math.PI * hs * hs), lim = (4 * hs) ** 2;
    for (const f of folds) {
      const T = f.train.map((i) => P[i]);
      const nLoc = localCounts(T, hs);
      for (const ti of f.test) {
        const q = P[ti], qn = { tod: q.tod, off: q.off };
        // 場所のカーネル（近くの乗車だけ）
        const near = [];
        for (let j = 0; j < T.length; j++) {
          const dx = q.x - T[j].x, dy = q.y - T[j].y, d2 = dx * dx + dy * dy;
          near.push(d2 < lim ? norm * Math.exp(-d2 / (2 * hs * hs)) : 0);
        }
        combos.forEach((cb, ci) => {
          let num = 0, den = 0;
          for (let j = 0; j < T.length; j++) {
            const w = timeWeight(T[j], qn, cb.st, nLoc[j] / (nLoc[j] + cb.K), cb.dayPen);
            den += w; if (near[j]) num += w * near[j];
          }
          sums[ci] += Math.log((1 - BG) * (num / den) + BG / area);
        });
        let num0 = 0;
        for (let j = 0; j < T.length; j++) num0 += near[j];
        sums[combos.length] += Math.log((1 - BG) * (num0 / T.length) + BG / area);
      }
    }
    combos.forEach((cb, ci) => { if (!best || sums[ci] > best.ll) best = { ll: sums[ci], params: { hs, ...cb } }; });
    bestNoTime = Math.max(bestNoTime, sums[combos.length]);
  }
  const n = P.length;
  return {
    params: best.params, fitted: true, n, days: days.length,
    score: best.ll / n, scoreNoTime: bestNoTime / n,
    gainTime: Math.exp((best.ll - bestNoTime) / n),
  };
}

// 空車で走っていた時間あたりの乗車の数（流し・アプリ配車など、待機して乗せたもの以外）。1件あたりの探す時間の目安に使う
export function pickupRate(rides, emptyMin) {
  const n = rides.filter((r) => r.kind !== '乗り場').length;
  return emptyMin > 60 && n ? n / (emptyMin / 60) : null; // 1時間あたり
}
