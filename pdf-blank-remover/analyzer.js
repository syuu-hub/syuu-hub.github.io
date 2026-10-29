// 空白ページ判定ワーカー
// 1ページ分の画像（RGBA）を受け取り、下処理 → 2値化 → 成分解析 → テキスト検出 → 判定 を行う
'use strict';

// 判定の厳しさごとの基準値
//  cut      : 2値化で「インク」とみなす明るさの上限（背景補正後 0-255。高いほど薄い線も拾う）
//  inkMax   : 判定対象の面積に占めるインクの割合
//  compMax  : ノイズを除いた図形（連結成分）の数
//  bigMm    : これより大きい図形が1つでもあれば内容あり（一辺 mm 換算）
//  noiseMm2 : これより小さい点はノイズとして無視（mm²）
//  charMin  : 埋め込みテキストの文字数
//  darkMax  : 写真・塗りつぶし・色付き領域の割合
const PRESETS = {
  strict: { cut: 222, inkMax: 0.0006, compMax: 6,  bigMm: 3, noiseMm2: 0.25, charMin: 1, darkMax: 0.002 },
  normal: { cut: 205, inkMax: 0.0015, compMax: 15, bigMm: 5, noiseMm2: 0.4,  charMin: 2, darkMax: 0.005 },
  loose:  { cut: 188, inkMax: 0.004,  compMax: 40, bigMm: 9, noiseMm2: 0.8,  charMin: 4, darkMax: 0.01 },
};

// 成分の分類
const C_NOISE = 0, C_IGNORED = 1, C_SIG = 2;

self.onmessage = e => {
  const m = e.data;
  if (m.cmd !== 'analyze') return;
  try {
    const { result, transfer } = analyze(m);
    self.postMessage({ type: 'done', id: m.id, result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};

function analyze(m) {
  const { id, w, h, dpi } = m;
  const opts = m.opts || {};
  const P = PRESETS[opts.level] || PRESETS.normal;
  const src = new Uint8ClampedArray(m.buf);
  const N = w * h, pxmm = dpi / 25.4;

  // ---- 判定対象の領域（外周の余白を除く）----
  const mg = Math.round(Math.min(w, h) * (opts.margin || 0) / 100);
  const R = { x0: mg, y0: mg, x1: w - mg, y1: h - mg };
  if (R.x1 <= R.x0 + 4 || R.y1 <= R.y0 + 4) { R.x0 = 0; R.y0 = 0; R.x1 = w; R.y1 = h; }
  const regionArea = (R.x1 - R.x0) * (R.y1 - R.y0);

  // ================= 下処理 =================
  // グレースケール
  const gray = new Uint8Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) gray[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;

  // 背景（紙の明るさ）をブロックごとに推定：明るい側 90% 点を紙の色とみなす
  const B = Math.max(8, Math.round(pxmm * 6));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B), NB = bw * bh;
  const bP90 = new Float32Array(NB), bChroma = new Float32Array(NB), bStd = new Float32Array(NB);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    hist.fill(0);
    const x0 = bx * B, x1 = Math.min(w, x0 + B), y0 = by * B, y1 = Math.min(h, y0 + B);
    let cnt = 0, sc = 0, sg = 0, sg2 = 0;
    for (let y = y0; y < y1; y++) {
      let i = y * w + x0, j = i * 4;
      for (let x = x0; x < x1; x++, i++, j += 4) {
        const g0 = gray[i];
        hist[g0]++; cnt++; sg += g0; sg2 += g0 * g0;
        const r = src[j], g = src[j + 1], b = src[j + 2];
        sc += Math.max(r, g, b) - Math.min(r, g, b);
      }
    }
    let acc = 0, v = 255;
    const lim = cnt * 0.1;
    for (; v > 0; v--) { acc += hist[v]; if (acc >= lim) break; }
    bP90[by * bw + bx] = v;
    bChroma[by * bw + bx] = sc / cnt;
    const mean = sg / cnt;
    bStd[by * bw + bx] = Math.sqrt(Math.max(0, sg2 / cnt - mean * mean));
  }

  // 用紙の外側（スキャン台の黒・影）：画像の端からつながる、暗くて一様なブロック
  // 写真などを誤って消さないよう、一様（ばらつきが小さい）なものに限り、全体の4割を超えたら取り消す
  const outside = new Uint8Array(NB);
  {
    const isBed = k => bP90[k] < 150 && bStd[k] < 14;
    const q = [];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      if (bx && by && bx < bw - 1 && by < bh - 1) continue;
      const k = by * bw + bx;
      if (isBed(k)) { outside[k] = 1; q.push(k); }
    }
    while (q.length) {
      const k = q.pop(), bx = k % bw, by = (k / bw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = bx + dx, yy = by + dy;
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const kk = yy * bw + xx;
        if (!outside[kk] && isBed(kk)) { outside[kk] = 1; q.push(kk); }
      }
    }
    // スキャン台は紙の周りに帯状に写る。全体の4割を超える、または端から2割より奥まで入り込むなら紙の中身とみなす
    let cnt = 0, deep = false;
    for (let k = 0; k < NB; k++) if (outside[k]) {
      cnt++;
      const bx = k % bw, by = (k / bw) | 0;
      if (Math.min(bx, bw - 1 - bx) > bw * 0.2 && Math.min(by, bh - 1 - by) > bh * 0.2) deep = true;
    }
    if (cnt > NB * 0.4 || deep) outside.fill(0);
    else if (cnt) {
      // 紙の縁の影も含めるため1ブロック広げる
      const grow = outside.slice();
      for (let k = 0; k < NB; k++) if (outside[k]) {
        const bx = k % bw, by = (k / bw) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = bx + dx, yy = by + dy;
          if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) grow[yy * bw + xx] = 1;
        }
      }
      outside.set(grow);
    }
  }
  // 表示用に、行ごとに横へ連なるブロックを1つの長方形にまとめる
  const outBoxes = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!outside[by * bw + bx]) continue;
      let ex = bx;
      while (ex + 1 < bw && outside[by * bw + ex + 1]) ex++;
      outBoxes.push([bx * B, by * B, Math.min(w, (ex + 1) * B) - bx * B, Math.min(B, h - by * B)]);
      bx = ex;
    }
  }
  const hasOut = outBoxes.length > 0;
  const isOut = (x, y) => outside[((y / B) | 0) * bw + ((x / B) | 0)] === 1;

  // スキャンのノイズの強さ（紙だけのブロックのばらつき）を測り、2値化の基準に使う
  const quietStd = [];
  for (let k = 0; k < NB; k++) if (!outside[k]) quietStd.push(bStd[k]);
  quietStd.sort((a, b) => a - b);
  const noiseSigma = quietStd.length ? quietStd[(quietStd.length * 0.25) | 0] : 0;
  // 文字の多いブロックに引っ張られないよう 3x3 最大 → 3x3 平均でならす
  const bMax = new Float32Array(NB), bg = new Float32Array(NB);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let mx = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = by + dy, xx = bx + dx;
      if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) mx = Math.max(mx, bP90[yy * bw + xx]);
    }
    bMax[by * bw + bx] = mx;
  }
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = by + dy, xx = bx + dx;
      if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { s += bMax[yy * bw + xx]; c++; }
    }
    bg[by * bw + bx] = Math.max(1, s / c);
  }

  // 写真・塗りつぶし・色付き領域（背景補正で消える部分）をブロック単位で拾う
  const inRegionBlock = (bx, by) => {
    const x0 = bx * B, y0 = by * B;
    return !outside[by * bw + bx] && x0 >= R.x0 && y0 >= R.y0 && Math.min(w, x0 + B) <= R.x1 && Math.min(h, y0 + B) <= R.y1;
  };
  const regP90 = [], regChroma = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) if (inRegionBlock(bx, by)) {
    regP90.push(bP90[by * bw + bx]); regChroma.push(bChroma[by * bw + bx]);
  }
  const paper = median(regP90) || 255;
  const paperChroma = median(regChroma) || 0;
  const darkCand = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (!inRegionBlock(bx, by)) continue;
    const k = by * bw + bx;
    if (bP90[k] < paper * 0.72 || bChroma[k] - paperChroma > 40) darkCand.push(k);
  }

  // 背景で割って照明ムラ・紙の黄ばみ・色紙を取り除く（白=255）
  const norm = new Uint8Array(N);
  const bxL = new Int32Array(w), bxR = new Int32Array(w), fxA = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let f = x / B - 0.5;
    f = Math.max(0, Math.min(bw - 1, f));
    const l = Math.floor(f);
    bxL[x] = l; bxR[x] = Math.min(bw - 1, l + 1); fxA[x] = f - l;
  }
  for (let y = 0; y < h; y++) {
    let f = y / B - 0.5;
    f = Math.max(0, Math.min(bh - 1, f));
    const t = Math.floor(f), b = Math.min(bh - 1, t + 1), fy = f - t;
    const rt = t * bw, rb = b * bw;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const fx = fxA[x], l = bxL[x], r = bxR[x];
      const top = bg[rt + l] + (bg[rt + r] - bg[rt + l]) * fx;
      const bot = bg[rb + l] + (bg[rb + r] - bg[rb + l]) * fx;
      const v = gray[i] * 255 / (top + (bot - top) * fy);
      norm[i] = v > 255 ? 255 : v;
    }
  }

  // ノイズ除去：3x3 ガウシアン（細い罫線を消さないよう中央値フィルタは使わない）
  const tmp = new Uint8Array(N), den = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const l = norm[o + (x > 0 ? x - 1 : x)], c = norm[o + x], r = norm[o + (x < w - 1 ? x + 1 : x)];
      tmp[o + x] = (l + 2 * c + r + 2) >> 2;
    }
  }
  for (let y = 0; y < h; y++) {
    const ou = (y > 0 ? y - 1 : y) * w, o = y * w, od = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) den[o + x] = (tmp[ou + x] + 2 * tmp[o + x] + tmp[od + x] + 2) >> 2;
  }

  // ================= 2値化（Sauvola 法 + 最低コントラスト）=================
  const W1 = w + 1;
  const sum = new Float64Array(W1 * (h + 1)), sq = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rq = 0;
    const o = y * w, a = (y + 1) * W1, p = y * W1;
    for (let x = 0; x < w; x++) {
      const v = den[o + x];
      rs += v; rq += v * v;
      sum[a + x + 1] = sum[p + x + 1] + rs;
      sq[a + x + 1] = sq[p + x + 1] + rq;
    }
  }
  const rad = Math.max(7, Math.round(pxmm * 4)), k = 0.3;
  // ノイズが強いページほど、ノイズを拾わないよう基準を濃い側へずらす（ぼかし後のノイズは元の約0.4倍）
  const cut = Math.min(P.cut, 255 - Math.max(30, 4.5 * 0.4 * noiseSigma));
  // 2段階しきい値：はっきりした線（強）と、うっすらした線（弱）を分けて拾い、弱は強につながるものだけ残す
  const weakCut = Math.min(250, cut + 20);
  // 周りの平均との差がこれ以上ならインクとみなす
  const minContrast = (255 - cut) * 0.6;
  // ぼかす前の画像はノイズを含むので、ノイズの強さ（背景補正後の尺度）の3倍だけ薄く見積もってから比べる
  const normPenalty = Math.round(3 * noiseSigma * 255 / Math.max(1, paper));
  const bin = new Uint8Array(N);
  // 芯：ぼかした画像でもはっきり濃い画素。ノイズの見分けや、インク量・大きさの計測に使う
  const core = new Uint8Array(N);
  let strong = new Int32Array(1 << 16), nStrong = 0;
  for (let y = R.y0; y < R.y1; y++) {
    const ya = Math.max(0, y - rad), yb = Math.min(h, y + rad + 1);
    const A = ya * W1, Bo = yb * W1;
    for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) {
      const nv = norm[i] + normPenalty, v = den[i], vv = v < nv ? v : nv;
      if (vv > weakCut) continue;
      if (hasOut && isOut(x, y)) continue;
      const xa = Math.max(0, x - rad), xb = Math.min(w, x + rad + 1);
      const n = (yb - ya) * (xb - xa);
      const s = sum[Bo + xb] - sum[Bo + xa] - sum[A + xb] + sum[A + xa];
      const q = sq[Bo + xb] - sq[Bo + xa] - sq[A + xb] + sq[A + xa];
      const mean = s / n, sd = Math.sqrt(Math.max(0, q / n - mean * mean));
      const thr = mean * (1 + k * (sd / 128 - 1));
      // 紙の明るさはそろえてあるので、周りより十分濃ければインク（Sauvola は濃い領域の中での補助）
      // はっきりした線かどうかは、ぼかす前の濃さで見る（細い線はぼかしで薄くなるため）
      const local = v < thr || v < 96 || mean - vv >= minContrast;
      if (vv <= cut && local) {
        bin[i] = 1;
        if (v <= cut) core[i] = 1;
        if (nStrong === strong.length) { const ns = new Int32Array(strong.length * 2); ns.set(strong); strong = ns; }
        strong[nStrong++] = i;
      } else if (v < thr || mean - vv >= minContrast * 0.5) bin[i] = 2;
    }
  }

  // 弱い画素は、強い画素から8近傍でつながる範囲だけ残す（かすれた線はつなぎ、離れた裏写りは捨てる）
  while (nStrong) {
    const i = strong[--nStrong], x = i % w;
    for (let dy = -w; dy <= w; dy += w) for (let dx = -1; dx <= 1; dx++) {
      if ((dx === -1 && x === 0) || (dx === 1 && x === w - 1)) continue;
      const j = i + dy + dx;
      if (j >= 0 && j < N && bin[j] === 2) {
        bin[j] = 1;
        if (nStrong === strong.length) { const ns = new Int32Array(strong.length * 2); ns.set(strong); strong = ns; }
        strong[nStrong++] = j;
      }
    }
  }
  for (let i = 0; i < N; i++) if (bin[i] === 2) bin[i] = 0;

  // クロージング（3x3 の膨張→収縮）：1画素の切れ目をふさぎ、かすれた文字を1つのまとまりにする
  closing3(bin, w, h, R);

  // ================= 成分解析（8近傍ラベリング）=================
  const lab = new Int32Array(N);
  let parent = new Int32Array(4096), next = 1;
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a === b) return a; if (a < b) { parent[b] = a; return a; } parent[a] = b; return b; };
  for (let y = R.y0; y < R.y1; y++) {
    for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) {
      if (!bin[i]) continue;
      let l = 0;
      if (x > 0 && lab[i - 1]) l = lab[i - 1];
      if (y > 0) {
        const u = i - w;
        if (x > 0 && lab[u - 1]) l = l ? unite(l, lab[u - 1]) : lab[u - 1];
        if (lab[u]) l = l ? unite(l, lab[u]) : lab[u];
        if (x < w - 1 && lab[u + 1]) l = l ? unite(l, lab[u + 1]) : lab[u + 1];
      }
      if (!l) {
        if (next >= parent.length) { const np = new Int32Array(parent.length * 2); np.set(parent); parent = np; }
        parent[next] = next; l = next++;
      }
      lab[i] = l;
    }
  }
  const idOf = new Int32Array(next).fill(-1);
  let nc = 0;
  for (let l = 1; l < next; l++) if (find(l) === l) idOf[l] = nc++;
  const cx0 = new Int32Array(nc).fill(w), cy0 = new Int32Array(nc).fill(h), cx1 = new Int32Array(nc).fill(-1), cy1 = new Int32Array(nc).fill(-1), carea = new Int32Array(nc), ccore = new Int32Array(nc);
  for (let y = R.y0; y < R.y1; y++) {
    for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) {
      if (!lab[i]) continue;
      const c = idOf[find(lab[i])];
      lab[i] = c + 1;
      carea[c]++; ccore[c] += core[i];
      if (x < cx0[c]) cx0[c] = x; if (x > cx1[c]) cx1[c] = x;
      if (y < cy0[c]) cy0[c] = y; if (y > cy1[c]) cy1[c] = y;
    }
  }

  // ノイズ・パンチ穴・スキャン端の影を除外し、意味のある図形だけ残す
  const cls = new Uint8Array(nc);
  const noiseA = P.noiseMm2 * pxmm * pxmm;
  const ignoredBoxes = [];
  let sigCount = 0, sigArea = 0, bigArea = 0, longExt = 0;
  const sigIdx = [];
  for (let c = 0; c < nc; c++) {
    const cw = cx1[c] - cx0[c] + 1, ch = cy1[c] - cy0[c] + 1, a = carea[c];
    // ノイズ：芯が小さく、短いもの（ホコリの点など）。かすれた線は芯が小さくても長さがあるので残す
    if (ccore[c] < noiseA && Math.max(cw, ch) < 1.5 * pxmm) { cls[c] = C_NOISE; continue; }
    // スキャン端の影：領域の端に接し、端からの奥行きが浅い
    const edge =
      (cx0[c] <= R.x0 && cx1[c] - R.x0 < w * 0.03) ||
      (cx1[c] >= R.x1 - 1 && R.x1 - cx0[c] < w * 0.03) ||
      (cy0[c] <= R.y0 && cy1[c] - R.y0 < h * 0.03) ||
      (cy1[c] >= R.y1 - 1 && R.y1 - cy0[c] < h * 0.03);
    // パンチ穴：端の近くにある直径 4〜8.5mm の丸（塗りつぶした円は面積比が約0.79。四角は1に近いので除く）
    const dmm = Math.max(cw, ch) / pxmm, ar = cw / ch, fill = a / (cw * ch);
    const mx = (cx0[c] + cx1[c]) / 2, my = (cy0[c] + cy1[c]) / 2;
    const nearEdge = mx < w * 0.18 || mx > w * 0.82 || my < h * 0.15 || my > h * 0.85;
    const hole = nearEdge && dmm >= 4 && dmm <= 8.5 && ar > 0.75 && ar < 1.33 && fill > 0.6 && fill < 0.88;
    if (edge || hole) {
      cls[c] = C_IGNORED;
      if (ignoredBoxes.length < 60) ignoredBoxes.push([cx0[c], cy0[c], cw, ch, hole ? 'hole' : 'edge']);
      continue;
    }
    cls[c] = C_SIG;
    sigIdx.push(c);
  }

  // 孤立した小さな点（1.2mm 未満で、3mm 以内に他に何もない）はホコリとみなす。文字の点や句読点は近くに文字がある
  {
    const G = Math.max(4, Math.round(3 * pxmm)), gw = Math.ceil(w / G), gh = Math.ceil(h / G);
    const cells = new Map();
    for (const c of sigIdx) {
      const gx0 = (cx0[c] / G) | 0, gx1 = Math.min(gw - 1, (cx1[c] / G) | 0), gy0 = (cy0[c] / G) | 0, gy1 = Math.min(gh - 1, (cy1[c] / G) | 0);
      if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 400) continue;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const key = gy * gw + gx;
        let l = cells.get(key); if (!l) cells.set(key, l = []);
        l.push(c);
      }
    }
    const small = 1.2 * pxmm;
    const isolated = c => {
      const gx = ((cx0[c] + cx1[c]) / 2 / G) | 0, gy = ((cy0[c] + cy1[c]) / 2 / G) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const l = cells.get((gy + dy) * gw + gx + dx);
        if (!l) continue;
        for (const o of l) {
          if (o === c) continue;
          const gapX = Math.max(cx0[o] - cx1[c], cx0[c] - cx1[o]), gapY = Math.max(cy0[o] - cy1[c], cy0[c] - cy1[o]);
          if (gapX <= G && gapY <= G) return false;
        }
      }
      return true;
    };
    const big = sigIdx.length > 3000;  // 図形がとても多いページは内容ありが明らかなので省く
    for (let k = sigIdx.length - 1; k >= 0 && !big; k--) {
      const c = sigIdx[k];
      if (Math.max(cx1[c] - cx0[c] + 1, cy1[c] - cy0[c] + 1) < small && isolated(c)) { cls[c] = C_NOISE; sigIdx.splice(k, 1); }
    }
  }
  for (const c of sigIdx) {
    const cw = cx1[c] - cx0[c] + 1, ch = cy1[c] - cy0[c] + 1;
    // インク量と大きさは芯で測る（薄い縁取りで膨らませない）。芯が無いかすれ線は全体の半分で数える
    const ink = ccore[c] || carea[c] * 0.5;
    sigCount++; sigArea += ink;
    if (ink > bigArea) bigArea = ink;
    if (Math.max(cw, ch) > longExt) longExt = Math.max(cw, ch);
  }

  // 色・濃い領域のうち、除外した図形（パンチ穴など）に重なるものは数えない
  const darkBoxes = [];
  for (const kk of darkCand) {
    const bx = kk % bw, by = (kk / bw) | 0;
    const x0 = bx * B, y0 = by * B, x1 = Math.min(w, x0 + B), y1 = Math.min(h, y0 + B);
    let skip = false;
    for (const ib of ignoredBoxes) if (x0 < ib[0] + ib[2] && x1 > ib[0] && y0 < ib[1] + ib[3] && y1 > ib[1]) { skip = true; break; }
    if (!skip) darkBoxes.push([x0, y0, x1 - x0, y1 - y0]);
  }
  const regionBlocks = Math.max(1, regP90.length);
  const darkRatio = darkBoxes.length / regionBlocks;

  // ================= テキスト検出 =================
  const lineBoxes = [];
  let embedChars = 0, textGlyphs = 0;
  const embedBoxes = [];
  if (opts.textDetect) {
    // 埋め込みテキスト（判定対象の領域内にあるものだけ）
    for (const t of m.textItems || []) {
      const cxm = t[0] + t[2] / 2, cym = t[1] + t[3] / 2;
      if (cxm >= R.x0 && cxm < R.x1 && cym >= R.y0 && cym < R.y1) { embedChars += t[4]; embedBoxes.push(t.slice(0, 4)); }
    }
    // 画像からの文字行検出：文字らしい大きさ・形の図形が並んでいるかを調べる（横書き・縦書き両対応）
    const minS = 1.0 * pxmm, maxS = 30 * pxmm;
    let cand = [];
    for (const c of sigIdx) {
      const cw = cx1[c] - cx0[c] + 1, ch = cy1[c] - cy0[c] + 1;
      const s = Math.max(cw, ch), t = Math.min(cw, ch);
      if (s < minS || s > maxS || s / t > 12) continue;
      const fill = carea[c] / (cw * ch);
      if (fill < 0.06) continue;
      cand.push(c);
    }
    if (cand.length > 4000) cand = cand.slice(0, 4000);
    const n = cand.length;
    const gp = new Int32Array(n);
    for (let i = 0; i < n; i++) gp[i] = i;
    const gf = a => { while (gp[a] !== a) { gp[a] = gp[gp[a]]; a = gp[a]; } return a; };
    const S = new Float32Array(n), MX = new Float32Array(n), MY = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = cand[i];
      S[i] = Math.max(cx1[c] - cx0[c] + 1, cy1[c] - cy0[c] + 1);
      MX[i] = (cx0[c] + cx1[c]) / 2; MY[i] = (cy0[c] + cy1[c]) / 2;
    }
    for (let i = 0; i < n; i++) {
      const a = cand[i];
      for (let j = i + 1; j < n; j++) {
        const s = Math.max(S[i], S[j]);
        if (s > 3 * Math.min(S[i], S[j])) continue;
        const b = cand[j];
        const gx = Math.max(cx0[b] - cx1[a], cx0[a] - cx1[b]);
        const gy = Math.max(cy0[b] - cy1[a], cy0[a] - cy1[b]);
        const horiz = Math.abs(MY[i] - MY[j]) <= 0.5 * s && gx <= 1.2 * s;
        const vert = Math.abs(MX[i] - MX[j]) <= 0.5 * s && gy <= 1.2 * s;
        if (horiz || vert) { const ra = gf(i), rb = gf(j); if (ra !== rb) gp[rb] = ra; }
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = gf(i);
      let g = groups.get(r);
      if (!g) { g = { n: 0, x0: w, y0: h, x1: 0, y1: 0, s: [] }; groups.set(r, g); }
      const c = cand[i];
      g.n++; g.s.push(S[i]);
      g.x0 = Math.min(g.x0, cx0[c]); g.y0 = Math.min(g.y0, cy0[c]);
      g.x1 = Math.max(g.x1, cx1[c]); g.y1 = Math.max(g.y1, cy1[c]);
    }
    for (const g of groups.values()) {
      if (g.n < 3) continue;
      const ms = median(g.s);
      const len = Math.max(g.x1 - g.x0 + 1, g.y1 - g.y0 + 1);
      if (len < 2.5 * ms) continue;
      textGlyphs += g.n;
      lineBoxes.push([g.x0, g.y0, g.x1 - g.x0 + 1, g.y1 - g.y0 + 1]);
    }
  }

  // ================= 判定 =================
  const bigThr = Math.pow(P.bigMm * pxmm, 2), longThr = P.bigMm * pxmm * 4;
  const inkRatio = sigArea / regionArea;
  const ratios = {
    ink: inkRatio / P.inkMax,
    comps: sigCount / P.compMax,
    big: bigArea / bigThr,
    long: longExt / longThr,
    dark: darkRatio / P.darkMax,
    chars: opts.textDetect ? embedChars / P.charMin : 0,
    lines: opts.textDetect ? lineBoxes.length : 0,
  };
  const score = Math.max(...Object.values(ratios));
  // 判定理由は文字か図形かを分けず、「何か書かれているか」だけを伝える
  const reasons = [];
  let verdict;
  if (score >= 1) {
    verdict = 'content';
    reasons.push('書き込みあり');
    // 文字が少しだけ（「このページは白紙です」やページ番号だけ等）は目で確かめてもらう
    const pixelOnly = Math.max(ratios.ink, ratios.big, ratios.dark);
    if (opts.textDetect && pixelOnly < 1.5 && textGlyphs <= 40 && embedChars <= 40 && ratios.comps < 4) {
      verdict = 'review';
      reasons[0] = 'わずかな書き込みのみ';
    }
  } else if (score < 0.35) {
    verdict = 'blank';
    reasons.push(sigCount ? '小さな汚れのみ' : '何も検出されず');
  } else {
    verdict = 'review';
    reasons.push('かすかな跡');
  }

  // 検出結果の枠：文字か図形かを分けず、検出したもの同士が近ければ（3mm以内）1つの枠にまとめる
  const marks = clusterBoxes(
    sigIdx.slice(0, 6000).map(c => [cx0[c], cy0[c], cx1[c] - cx0[c] + 1, cy1[c] - cy0[c] + 1])
      .concat(darkBoxes, embedBoxes),
    3 * pxmm,
  ).slice(0, 600);

  const result = {
    verdict, reasons,
    w, h, region: [R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0],
    marks,
    outside: outBoxes,
    noise: Math.round(noiseSigma * 10) / 10,
  };
  const transfer = [];
  if (opts.dupDetect && verdict !== 'blank') {
    result.fp = fingerprint();
    transfer.push(result.fp.fine.buffer, result.fp.ink.buffer, result.fp.tone.buffer);
  }
  if (m.wantBinary) {
    // 0=背景 1=無視した点（ノイズ・影・穴） 2=判定に使ったもの
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (lab[i]) out[i] = cls[lab[i] - 1] === C_SIG ? 2 : 1;
    result.binary = out;
    result.pre = den;
    transfer.push(out.buffer, den.buffer);
  }
  return { result, transfer };

  // 重複ページ検出用の指紋
  //  fine : 下処理後の画像を 1mm 角に縮め、3x3 でならしたもの（少しのずれでは一致度が落ちないように）
  //  ink  : 判定範囲を 48x64 マスに分けたインクの有無（候補をすばやく絞るため）
  //  tone : 下処理後の画像の 16x16 平均濃淡
  function fingerprint() {
    const mm2 = pxmm * pxmm, fw = Math.max(1, Math.floor(w / pxmm)), fh = Math.max(1, Math.floor(h / pxmm));
    const raw = new Float32Array(fw * fh);
    for (let gy = 0; gy < fh; gy++) for (let gx = 0; gx < fw; gx++) {
      const x0 = Math.round(gx * pxmm), x1 = Math.max(x0 + 1, Math.round((gx + 1) * pxmm));
      const y0 = Math.round(gy * pxmm), y1 = Math.max(y0 + 1, Math.round((gy + 1) * pxmm));
      let sm = 0, c = 0;
      for (let y = y0; y < y1 && y < h; y++) for (let x = x0, i = y * w + x0; x < x1 && x < w; x++, i++) { sm += den[i]; c++; }
      raw[gy * fw + gx] = c ? sm / c : 255;
    }
    const fine = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      let sm = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < fh && xx >= 0 && xx < fw) { sm += raw[yy * fw + xx]; c++; }
      }
      fine[y * fw + x] = Math.round(sm / c);
    }
    const FW = 48, FH = 64, rw = R.x1 - R.x0, rh = R.y1 - R.y0;
    const cnt = new Uint16Array(FW * FH), toneSum = new Float64Array(256), toneN = new Uint32Array(256);
    for (let y = R.y0; y < R.y1; y++) {
      const fy = ((y - R.y0) * FH / rh) | 0, ty = ((y - R.y0) * 16 / rh) | 0;
      for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) {
        const tk = ty * 16 + (((x - R.x0) * 16 / rw) | 0);
        toneSum[tk] += den[i]; toneN[tk]++;
        if (lab[i] && cls[lab[i] - 1] === C_SIG) cnt[fy * FW + (((x - R.x0) * FW / rw) | 0)]++;
      }
    }
    const ink = new Uint8Array(FW * FH);
    for (let k = 0; k < ink.length; k++) ink[k] = cnt[k] >= 3 ? 1 : 0;
    for (const b of darkBoxes) {
      const gx0 = Math.max(0, ((b[0] - R.x0) * FW / rw) | 0), gx1 = Math.min(FW - 1, ((b[0] + b[2] - 1 - R.x0) * FW / rw) | 0);
      const gy0 = Math.max(0, ((b[1] - R.y0) * FH / rh) | 0), gy1 = Math.min(FH - 1, ((b[1] + b[3] - 1 - R.y0) * FH / rh) | 0);
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) ink[gy * FW + gx] = 1;
    }
    const tone = new Float32Array(256);
    for (let k = 0; k < 256; k++) tone[k] = toneN[k] ? toneSum[k] / toneN[k] : 255;
    return { fine, fw, fh, ink, tone, wmm: w / pxmm, hmm: h / pxmm, inkArea: sigArea / mm2 };
  }
}

// 3x3 のクロージング（膨張→収縮）。判定対象の領域 R の中だけ処理する
function closing3(bin, w, h, R) {
  const N = w * h, a = new Uint8Array(N), b = new Uint8Array(N);
  const x0 = Math.max(1, R.x0), x1 = Math.min(w - 1, R.x1), y0 = Math.max(1, R.y0), y1 = Math.min(h - 1, R.y1);
  // 膨張（横 → 縦）
  for (let y = y0; y < y1; y++) for (let x = x0, i = y * w + x0; x < x1; x++, i++) a[i] = bin[i - 1] | bin[i] | bin[i + 1];
  for (let y = y0; y < y1; y++) for (let x = x0, i = y * w + x0; x < x1; x++, i++) b[i] = a[i - w] | a[i] | a[i + w];
  // 収縮（横 → 縦）
  for (let y = y0; y < y1; y++) for (let x = x0, i = y * w + x0; x < x1; x++, i++) a[i] = b[i - 1] & b[i] & b[i + 1];
  for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1, i = y * w + x0 + 1; x < x1 - 1; x++, i++) bin[i] = a[i - w] & a[i] & a[i + w];
}

// 近い枠同士をまとめる（x で並べて掃引し、間隔 gap 以内で重なるものを同じかたまりにする）
function clusterBoxes(boxes, gap) {
  const n = boxes.length;
  if (!n) return [];
  const order = boxes.map((b, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let oi = 0; oi < n; oi++) {
    const a = boxes[order[oi]], ax1 = a[0] + a[2] + gap;
    for (let oj = oi + 1; oj < n; oj++) {
      const b = boxes[order[oj]];
      if (b[0] > ax1) break;
      if (b[1] <= a[1] + a[3] + gap && a[1] <= b[1] + b[3] + gap) {
        const ra = find(order[oi]), rb = find(order[oj]);
        if (ra !== rb) par[rb] = ra;
      }
    }
  }
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i), b = boxes[i];
    const c = out.get(r);
    if (!c) out.set(r, [b[0], b[1], b[0] + b[2], b[1] + b[3]]);
    else { c[0] = Math.min(c[0], b[0]); c[1] = Math.min(c[1], b[1]); c[2] = Math.max(c[2], b[0] + b[2]); c[3] = Math.max(c[3], b[1] + b[3]); }
  }
  return [...out.values()].map(c => [c[0], c[1], c[2] - c[0], c[3] - c[1]]).sort((a, b) => b[2] * b[3] - a[2] * a[3]);
}

function median(arr) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[a.length >> 1];
}
