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
import { isOffDay, isPreOffNight, serviceDay, isNight, socialCalendar } from './calendar.js?v=42';

// 人の暮らしのリズムの要素（営業ログで確かめる。確かめられない時はこの初期値＝理論からの値）
//   dowPen：同じ曜日でない乗車を弱める（人の動きは1週間の周期でくり返す。González ほか 2008、Song ほか 2010）
//   pre：休みの前の夜（金曜・祝前日の夜）を、ふだんの平日の夜と別の種類の日として見る
//   cal：社会の暦（給料日のあと・忘年会・新年会の夜）に、夜に乗せることが多いエリアを高く見る
export const DEFAULT_PARAMS = { hs: 250, st: 60, K: 8, dayPen: 0.5, dowPen: 0.3, pre: 1, cal: 1 };
export const GRID = { hs: [120, 200, 300, 450, 700], st: [30, 60, 120, 240], K: [1, 3, 8, 20, 60], dayPen: [0, 0.4, 0.8] };
const DAY_MIN = 1440;
const MIN_EVIDENCE = 10; // 暮らしのリズムの要素を営業ログで良い・悪いと決めるのに要る乗車の数
const BG = 0.05; // 予報のうち一様分布に回す割合（初めての場所でも確率0にしない、頑健な混合）

// 乗車 → 計算用（平面のメートル座標、時刻・曜日）
export function prep(rides, origin = null) {
  const o = origin || (rides.length ? [rides[0].lng, rides[0].lat] : [0, 0]);
  const kx = 111320 * Math.cos((o[1] * Math.PI) / 180), ky = 110540;
  return rides.map((r) => {
    const d = new Date(r.t);
    const c = socialCalendar(d);
    return { x: (r.lng - o[0]) * kx, y: (r.lat - o[1]) * ky, ...nowInfo(d), night: isNight(d), cal: c, day: d.toDateString(), fare: r.fare || 0 };
  });
}
export const toXY = (p, origin) => [(p[0] - origin[0]) * 111320 * Math.cos((origin[1] * Math.PI) / 180), (p[1] - origin[1]) * 110540];

// 時刻 now における乗車 r の重み（時刻のカーネル × 平日／休日、経験ベイズの縮小つき、1日の平均が1になるよう正規化）
export function timeWeight(r, now, st, c, dayPen, dowPen = 0, pre = 0) {
  const md = Math.abs(r.tod - now.tod) % DAY_MIN;
  const dm = Math.min(md, DAY_MIN - md);
  const g = Math.exp(-(dm * dm) / (2 * st * st));
  const mean = Math.min(1, (st * Math.sqrt(2 * Math.PI)) / DAY_MIN); // 時刻カーネルの1日の平均
  const tw = (1 - c + c * g) / (1 - c + c * mean);
  // 日の種類：平日・休日（pre なら、休みの前の夜も別の種類）。種類が違えば dayPen、同じ種類でも曜日が違えば dowPen だけ弱める
  const tr = pre ? r.type3 : r.off ? 'off' : 'on', tn = pre ? now.type3 : now.off ? 'off' : 'on';
  if (tr !== tn) return tw * (1 - Math.max(dayPen, dowPen) * c); // 日の種類が違えば、曜日が違うより弱く（少なくとも同じだけ）
  return r.dow === now.dow ? tw : tw * (1 - dowPen * c);
}
export const nowInfo = (date) => {
  const off = isOffDay(date);
  return { tod: date.getHours() * 60 + date.getMinutes(), off, dow: serviceDay(date).getDay(), type3: isPreOffNight(date) ? 'pre' : off ? 'off' : 'on', cal: socialCalendar(date) };
};
// 夜に乗せることが多いエリアか（0〜1）：まわりの乗車のうち、夜（18時〜翌3時）の乗車の割合（場所のカーネルで）
export function nightShares(P, hs) {
  const out = new Float64Array(P.length), lim = (3 * hs) ** 2;
  for (let i = 0; i < P.length; i++) {
    let n = 0, s = 0;
    for (let j = 0; j < P.length; j++) {
      const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy;
      if (d2 >= lim) continue;
      const k = Math.exp(-d2 / (2 * hs * hs));
      n += k; if (P[j].night) s += k;
    }
    out[i] = n > 0 ? s / n : 0;
  }
  return out;
}
// 社会の暦の倍率：今が給料日のあと等の夜なら、夜に乗せることが多いエリア（nightShare）ほど高く
export const calWeight = (nightShare, cal, on) => (on && cal ? 1 + (cal.mult - 1) * nightShare : 1);

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
// 1日ずつ抜いて当てる交差検証の対数予測スコア（combos のそれぞれ、最後の1つは時刻を使わない見方）
function cvScores(P, folds, area, hs, combos) {
  const sums = new Float64Array(combos.length + 1);
  const norm = 1 / (2 * Math.PI * hs * hs), lim = (4 * hs) ** 2;
  for (const f of folds) {
    const T = f.train.map((i) => P[i]);
    const nLoc = localCounts(T, hs);
    const nShare = combos.some((cb) => cb.cal) ? nightShares(T, hs) : null;
    for (const ti of f.test) {
      const q = P[ti];
      // 場所のカーネル（近くの乗車だけ）
      const near = new Float64Array(T.length);
      for (let j = 0; j < T.length; j++) {
        const dx = q.x - T[j].x, dy = q.y - T[j].y, d2 = dx * dx + dy * dy;
        near[j] = d2 < lim ? norm * Math.exp(-d2 / (2 * hs * hs)) : 0;
      }
      combos.forEach((cb, ci) => {
        let num = 0, den = 0;
        for (let j = 0; j < T.length; j++) {
          let w = timeWeight(T[j], q, cb.st, nLoc[j] / (nLoc[j] + cb.K), cb.dayPen, cb.dowPen || 0, cb.pre || 0);
          if (cb.cal) w *= calWeight(nShare[j], q.cal, 1);
          den += w; if (near[j]) num += w * near[j];
        }
        sums[ci] += Math.log((1 - BG) * (num / den) + BG / area);
      });
      let num0 = 0;
      for (let j = 0; j < T.length; j++) num0 += near[j];
      sums[combos.length] += Math.log((1 - BG) * (num0 / T.length) + BG / area);
    }
  }
  return sums;
}

// 交差検証で設定を選ぶ。戻り値：{ params, fitted, n, days, score, scoreNoTime, gainTime, social }
//   score：1件あたりの対数予測スコア、gainTime：時刻を使うことで、実際の乗車場所に付く確率が何倍になったか
//   social：人の暮らしのリズムの要素（曜日の周期・休みの前の夜・社会の暦）を、営業ログで確かめた結果
// 1段目で場所・時刻の幅などを選び、2段目でその設定のまま暮らしのリズムの要素を1つずつ確かめる。
// 営業ログで差が出ない要素（その時期の乗車がまだ無いなど）は、理論からの初期値のまま使う
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
    const sums = cvScores(P, folds, area, hs, combos);
    combos.forEach((cb, ci) => { if (!best || sums[ci] > best.ll) best = { ll: sums[ci], params: { hs, ...cb } }; });
    bestNoTime = Math.max(bestNoTime, sums[combos.length]);
  }
  // 2段目：暮らしのリズムの要素を1つずつ（使う・使わない）確かめる。差がわずか（1件あたり0.1%未満）なら理論からの初期値
  const n = P.length, EPS = n * 1e-3;
  const base = { ...best.params, dowPen: 0, pre: 0, cal: 0 };
  const social = {};
  const counts = { dowPen: n, pre: P.filter((p) => p.type3 === 'pre').length, cal: P.filter((p) => p.cal).length };
  let cur = { ...base }, curLL = best.ll;
  // 休みの前の夜は、日の種類の違いの強さ（dayPen）も合わせて選び直す（平日だけのデータでは dayPen が0に選ばれているため）
  const trials = [['pre', [{ pre: 1, dayPen: Math.max(0.4, cur.dayPen) }, { pre: 1, dayPen: 0.8 }]], ['dowPen', [{ dowPen: 0.3 }, { dowPen: 0.6 }]], ['cal', [{ cal: 1 }]]];
  for (const [k, vals] of trials) {
    const cands = vals.map((v) => ({ ...cur, ...v }));
    const sums = cvScores(P, folds, area, cur.hs, cands);
    let bi = -1;
    cands.forEach((cb, i) => { if (bi < 0 || sums[i] > sums[bi]) bi = i; });
    const gain = sums[bi] - curLL;
    // 確かめられない（その時期の乗車が無い）・差がわずか → 初期値のまま。はっきり良い → 使う。はっきり悪い → 使わない
    let use, verdict;
    // その時期の乗車が10件未満では、良し悪しを決めない（偶然の差を拾わない）
    let next;
    if (counts[k] < MIN_EVIDENCE || Math.abs(gain) < EPS) { verdict = counts[k] < MIN_EVIDENCE ? 'few' : 'prior'; next = { ...cur, [k]: DEFAULT_PARAMS[k] }; } // 日の種類の強さ（dayPen）は1段目で営業ログから選んだまま
    else if (gain > 0) { verdict = 'better'; next = cands[bi]; }
    else { verdict = 'worse'; next = { ...cur, [k]: 0 }; }
    use = next[k];
    social[k] = { use, verdict, gain: Math.exp(gain / n), n: counts[k] };
    if (verdict === 'better') curLL = sums[bi];
    else if (JSON.stringify(next) !== JSON.stringify(cur)) curLL = cvScores(P, folds, area, next.hs, [next])[0];
    cur = next;
  }
  return {
    params: cur, fitted: true, n, days: days.length,
    score: curLL / n, scoreNoTime: bestNoTime / n,
    gainTime: Math.exp((best.ll - bestNoTime) / n),
    gainSocial: Math.exp((curLL - best.ll) / n),
    social,
  };
}

// 空車で走っていた時間あたりの乗車の数（流し・アプリ配車など、待機して乗せたもの以外）。1件あたりの探す時間の目安に使う
export function pickupRate(rides, emptyMin) {
  const n = rides.filter((r) => r.kind !== '乗り場').length;
  return emptyMin > 60 && n ? n / (emptyMin / 60) : null; // 1時間あたり
}
