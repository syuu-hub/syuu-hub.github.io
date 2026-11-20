// 対象地域：関西圏（大阪・京都・兵庫・奈良・滋賀・和歌山）
// 地図データ（タイル）はこの範囲だけを読み込み、地図もこの範囲の外へは動かさない。住所の検索もこの範囲の結果だけ使う
export const REGION_NAME = '関西圏';
// [西, 南, 東, 北]（2府4県が入るように少し余裕をもたせる）
export const REGION_BOUNDS = [134.0, 33.3, 136.8, 35.9];
// 地図を動かせる範囲（端のエリアも画面の真ん中に出せるよう、タイルの範囲より少し広く）
export const VIEW_BOUNDS = [[133.6, 33.0], [137.2, 36.2]];
export const REGION_CENTER = [135.1955, 34.6946]; // 三宮
export const MIN_ZOOM = 8; // これより引いた（日本全体などの）地図は読み込まない

export const inRegion = (lng, lat) => lng >= REGION_BOUNDS[0] && lng <= REGION_BOUNDS[2] && lat >= REGION_BOUNDS[1] && lat <= REGION_BOUNDS[3];

// 地図のスタイルを読み込み、タイルの出どころ（source）に範囲（bounds）を付ける。範囲の外のタイルは読み込まれない。
// TileJSON（url）で指定された出どころは、範囲が上書きされないように中身（tiles など）を直接書き込む
export async function regionStyle(styleUrl, fetcher = fetch, timeoutMs = 8000) {
  const get = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetcher(url, { signal: ctl.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
    finally { clearTimeout(t); }
  };
  const style = await get(styleUrl);
  for (const [id, src] of Object.entries(style.sources || {})) {
    if (!/^(vector|raster|raster-dem)$/.test(src.type)) continue;
    if (src.url) {
      const tj = await get(new URL(src.url, styleUrl).href);
      if (!Array.isArray(tj.tiles) || !tj.tiles.length) throw new Error(`no tiles in ${id}`);
      src.tiles = tj.tiles;
      for (const k of ['minzoom', 'maxzoom', 'attribution', 'scheme', 'tileSize', 'encoding']) if (tj[k] != null && src[k] == null) src[k] = tj[k];
      delete src.url;
    }
    src.bounds = REGION_BOUNDS.slice();
  }
  return style;
}
