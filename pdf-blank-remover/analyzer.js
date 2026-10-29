// 空白ページ判定ワーカー
// 1ページ分の画像（RGBA）を受け取り、下処理 → 2値化 → 成分解析 → テキスト検出 → 判定 を行う
// 進み具合は stage / band メッセージで逐次知らせ、画面側でデフラグ風に描く
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

// 解析マップのタイル状態（画面側と共通）
const T = { EMPTY: 0, EXCL: 1, NOISE: 2, INK: 3, TEXT: 4, DARK: 5, EMBED: 6, IGNORED: 7 };
const RANK = [0, 0, 1, 3, 5, 4, 6, 2];

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
  const post = o => self.postMessage(Object.assign({ id }, o));
  const stage = s => post({ type: 'stage', stage: s });

  // ---- 判定対象の領域（外周の余白・ヘッダー/フッターを除く）----
  const mg = Math.round(Math.min(w, h) * (opts.margin || 0) / 100);
  const hf = opts.ignoreHF ? Math.round(h * 0.08) : 0;
  const R = { x0: mg, y0: Math.max(mg, hf), x1: w - mg, y1: h - Math.max(mg, hf) };
  if (R.x1 <= R.x0 + 4 || R.y1 <= R.y0 + 4) { R.x0 = 0; R.y0 = 0; R.x1 = w; R.y1 = h; }
  const regionArea = (R.x1 - R.x0) * (R.y1 - R.y0);

  // ---- 解析マップ（デフラグ表示用のタイル）----
  const cols = 24, tw = w / cols, rows = Math.max(1, Math.round(h / tw)), th = h / rows;
  const tiles = new Uint8Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const x0 = tx * tw, x1 = x0 + tw, y0 = ty * th, y1 = y0 + th;
    if (x1 <= R.x0 || x0 >= R.x1 || y1 <= R.y0 || y0 >= R.y1) tiles[ty * cols + tx] = T.EXCL;
  }
  const tileX = new Uint16Array(w), tileRowOf = new Uint16Array(h);
  for (let x = 0; x < w; x++) tileX[x] = Math.min(cols - 1, Math.floor(x / tw));
  for (let y = 0; y < h; y++) tileRowOf[y] = Math.min(rows - 1, Math.floor(y / th));
  post({ type: 'grid', cols, rows, tiles: tiles.slice() });

  // ================= 下処理 =================
  stage('pre');
  // グレースケール
  const gray = new Uint8Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) gray[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;

  // 背景（紙の明るさ）をブロックごとに推定：明るい側 90% 点を紙の色とみなす
  const B = Math.max(8, Math.round(pxmm * 6));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B), NB = bw * bh;
  const bP90 = new Float32Array(NB), bChroma = new Float32Array(NB);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    hist.fill(0);
    const x0 = bx * B, x1 = Math.min(w, x0 + B), y0 = by * B, y1 = Math.min(h, y0 + B);
    let cnt = 0, sc = 0;
    for (let y = y0; y < y1; y++) {
      let i = y * w + x0, j = i * 4;
      for (let x = x0; x < x1; x++, i++, j += 4) {
        hist[gray[i]]++; cnt++;
        const r = src[j], g = src[j + 1], b = src[j + 2];
        sc += Math.max(r, g, b) - Math.min(r, g, b);
      }
    }
    let acc = 0, v = 255;
    const lim = cnt * 0.1;
    for (; v > 0; v--) { acc += hist[v]; if (acc >= lim) break; }
    bP90[by * bw + bx] = v;
    bChroma[by * bw + bx] = sc / cnt;
  }
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
    return x0 >= R.x0 && y0 >= R.y0 && Math.min(w, x0 + B) <= R.x1 && Math.min(h, y0 + B) <= R.y1;
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
  stage('bin');
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
  const bin = new Uint8Array(N);
  const tileInk = new Uint32Array(cols * rows);
  let curRow = tileRowOf[R.y0] || 0;
  const sendBand = row => {
    const data = new Uint8Array(cols);
    for (let tx = 0; tx < cols; tx++) {
      const t = row * cols + tx;
      data[tx] = tiles[t] === T.EXCL ? T.EXCL : (tileInk[t] ? T.INK : T.EMPTY);
    }
    post({ type: 'band', row, data });
  };
  for (let y = R.y0; y < R.y1; y++) {
    const tr = tileRowOf[y];
    if (tr !== curRow) { for (let r = curRow; r < tr; r++) sendBand(r); curRow = tr; }
    const ya = Math.max(0, y - rad), yb = Math.min(h, y + rad + 1);
    const A = ya * W1, Bo = yb * W1;
    for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) {
      const v = den[i];
      if (v > P.cut) continue;
      const xa = Math.max(0, x - rad), xb = Math.min(w, x + rad + 1);
      const n = (yb - ya) * (xb - xa);
      const s = sum[Bo + xb] - sum[Bo + xa] - sum[A + xb] + sum[A + xa];
      const q = sq[Bo + xb] - sq[Bo + xa] - sq[A + xb] + sq[A + xa];
      const mean = s / n, sd = Math.sqrt(Math.max(0, q / n - mean * mean));
      const thr = mean * (1 + k * (sd / 128 - 1));
      if (v < thr || v < 96) { bin[i] = 1; tileInk[tr * cols + tileX[x]]++; }
    }
  }
  for (let r = curRow; r < rows; r++) if (r <= tileRowOf[Math.max(0, R.y1 - 1)]) sendBand(r);

  // ================= 成分解析（8近傍ラベリング）=================
  stage('cc');
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
  const cx0 = new Int32Array(nc).fill(w), cy0 = new Int32Array(nc).fill(h), cx1 = new Int32Array(nc).fill(-1), cy1 = new Int32Array(nc).fill(-1), carea = new Int32Array(nc);
  for (let y = R.y0; y < R.y1; y++) {
    for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) {
      if (!lab[i]) continue;
      const c = idOf[find(lab[i])];
      lab[i] = c + 1;
      carea[c]++;
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
    if (a < noiseA) { cls[c] = C_NOISE; continue; }
    // スキャン端の影：領域の端に接し、端からの奥行きが浅い
    const edge =
      (cx0[c] <= R.x0 && cx1[c] - R.x0 < w * 0.03) ||
      (cx1[c] >= R.x1 - 1 && R.x1 - cx0[c] < w * 0.03) ||
      (cy0[c] <= R.y0 && cy1[c] - R.y0 < h * 0.03) ||
      (cy1[c] >= R.y1 - 1 && R.y1 - cy0[c] < h * 0.03);
    // パンチ穴：端の近くにある直径 4〜8.5mm の丸
    const dmm = Math.max(cw, ch) / pxmm, ar = cw / ch, fill = a / (cw * ch);
    const mx = (cx0[c] + cx1[c]) / 2, my = (cy0[c] + cy1[c]) / 2;
    const nearEdge = mx < w * 0.18 || mx > w * 0.82 || my < h * 0.15 || my > h * 0.85;
    const hole = nearEdge && dmm >= 4 && dmm <= 8.5 && ar > 0.75 && ar < 1.33 && fill > 0.5;
    if (edge || hole) {
      cls[c] = C_IGNORED;
      if (ignoredBoxes.length < 60) ignoredBoxes.push([cx0[c], cy0[c], cw, ch, hole ? 'hole' : 'edge']);
      continue;
    }
    cls[c] = C_SIG;
    sigCount++; sigArea += a; sigIdx.push(c);
    if (a > bigArea) bigArea = a;
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
    stage('text');
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
  stage('judge');
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
  const reasons = [];
  if (ratios.chars >= 1) reasons.push(`埋め込みテキスト ${embedChars}文字`);
  if (ratios.lines >= 1) reasons.push(`文字 約${textGlyphs}字（${lineBoxes.length}か所）`);
  if (ratios.dark >= 1) reasons.push(`写真・塗り・色の領域 ${(darkRatio * 100).toFixed(1)}%`);
  if (ratios.big >= 1) reasons.push('大きな図形あり');
  else if (ratios.long >= 1) reasons.push('長い線あり');
  if (ratios.ink >= 1) reasons.push(`インク ${(inkRatio * 100).toFixed(2)}%`);
  if (ratios.comps >= 1) reasons.push(`図形 ${sigCount}個`);

  let verdict;
  if (score >= 1) {
    verdict = 'content';
    // 文字が少しだけ（「このページは白紙です」やページ番号だけ等）は目で確かめてもらう
    const pixelOnly = Math.max(ratios.ink, ratios.big, ratios.dark);
    if (opts.textDetect && pixelOnly < 1.5 && textGlyphs <= 40 && embedChars <= 40 && ratios.comps < 4) {
      verdict = 'review';
      reasons.unshift(textGlyphs || embedChars ? 'わずかな文字のみ' : 'わずかな跡のみ');
    }
  } else if (score < 0.35) {
    verdict = 'blank';
    reasons.push(sigCount ? `小さな汚れ ${sigCount}個のみ` : '何も検出されず');
  } else {
    verdict = 'review';
    reasons.push('かすかな痕跡');
  }

  // ---- 解析マップの最終状態 ----
  const setTile = (t, s) => { if (tiles[t] !== T.EXCL && RANK[s] > RANK[tiles[t]]) tiles[t] = s; };
  const clsTile = [T.NOISE, T.IGNORED, T.INK];
  for (let y = R.y0; y < R.y1; y++) {
    const tr = tileRowOf[y] * cols;
    for (let x = R.x0, i = y * w + R.x0; x < R.x1; x++, i++) if (lab[i]) setTile(tr + tileX[x], clsTile[cls[lab[i] - 1]]);
  }
  const markBox = (b, s) => {
    const tx0 = tileX[clamp(b[0] | 0, 0, w - 1)], tx1 = tileX[clamp((b[0] + b[2] - 1) | 0, 0, w - 1)];
    const ty0 = tileRowOf[clamp(b[1] | 0, 0, h - 1)], ty1 = tileRowOf[clamp((b[1] + b[3] - 1) | 0, 0, h - 1)];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) setTile(ty * cols + tx, s);
  };
  darkBoxes.forEach(b => markBox(b, T.DARK));
  lineBoxes.forEach(b => markBox(b, T.TEXT));
  embedBoxes.forEach(b => markBox(b, T.EMBED));

  const result = {
    verdict, score, reasons,
    features: { embedChars, lines: lineBoxes.length, glyphs: textGlyphs, inkRatio, comps: sigCount, noise: nc - sigCount - ignoredBoxes.length, darkRatio, bigMm: Math.sqrt(bigArea) / pxmm, longMm: longExt / pxmm },
    cols, rows, tiles, w, h, region: [R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0],
    boxes: {
      lines: lineBoxes.slice(0, 300),
      embed: embedBoxes.slice(0, 300),
      dark: darkBoxes.slice(0, 400),
      ignored: ignoredBoxes,
      comps: sigIdx.slice(0, 400).map(c => [cx0[c], cy0[c], cx1[c] - cx0[c] + 1, cy1[c] - cy0[c] + 1]),
    },
  };
  const transfer = [];
  if (m.wantBinary) {
    // 0=背景 1=ノイズ 2=除外 3=図形
    const out = new Uint8Array(N);
    const map = [1, 2, 3];
    for (let i = 0; i < N; i++) if (lab[i]) out[i] = map[cls[lab[i] - 1]];
    result.binary = out;
    transfer.push(out.buffer);
  }
  return { result, transfer };
}

function median(arr) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[a.length >> 1];
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
