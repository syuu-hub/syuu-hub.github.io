// node test/region.test.mjs — 地図データを関西圏だけにする（スタイルの書き換え）、住所の検索も関西圏だけ
import { regionStyle, inRegion, REGION_BOUNDS } from '../js/region.js';
import { geocode } from '../js/places.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('NG:', m); } else console.log('OK:', m); };
const res = (body) => ({ ok: true, status: 200, json: async () => body });

ok(inRegion(135.1955, 34.6946) && inRegion(135.7681, 35.0116) && inRegion(135.1675, 34.2261) && inRegion(135.8048, 34.6851) && inRegion(136.2, 35.4), '神戸・京都・和歌山・奈良・滋賀は範囲内');
ok(!inRegion(139.7671, 35.6812) && !inRegion(136.9066, 35.1815) && !inRegion(133.9195, 34.6551), '東京・名古屋・岡山は範囲外');

// スタイル：TileJSON の出どころは中身を書き込み、範囲を付ける。ラスターも範囲を付ける
const calls = [];
const fetcher = async (url) => {
  calls.push(url);
  if (url.endsWith('/styles/liberty')) return res({ version: 8, sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.example/planet' },
    ne2_shaded: { type: 'raster', tiles: ['https://tiles.example/ne/{z}/{x}/{y}.png'], maxzoom: 6 },
    geo: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  }, layers: [] });
  if (url.endsWith('/planet')) return res({ tiles: ['https://tiles.example/planet/2026/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14, attribution: '© OSM', bounds: [-180, -85, 180, 85] });
  throw new Error('unexpected ' + url);
};
const st = await regionStyle('https://tiles.example/styles/liberty', fetcher);
const v = st.sources.openmaptiles;
ok(!v.url && v.tiles[0].includes('{z}') && v.maxzoom === 14 && v.attribution === '© OSM', 'TileJSON の中身を書き込む（範囲が世界全体で上書きされないように）');
ok(JSON.stringify(v.bounds) === JSON.stringify(REGION_BOUNDS) && JSON.stringify(st.sources.ne2_shaded.bounds) === JSON.stringify(REGION_BOUNDS), 'タイルの出どころに関西圏の範囲');
ok(!st.sources.geo.bounds, 'GeoJSON には付けない');
try { await regionStyle('https://tiles.example/styles/liberty', async () => { throw new Error('offline'); }); ok(false, '読み込めない時は例外'); } catch { ok(true, '読み込めない時は例外（呼び出し側は普通のスタイルで続ける）'); }

// 住所の検索：関西圏の外の結果は使わない
const tokyo = async (url) => (/gsi/.test(url) ? res([{ geometry: { coordinates: [139.7671, 35.6812] }, properties: { title: '東京都千代田区丸の内' } }]) : res([]));
ok((await geocode('丸の内1丁目', tokyo)) === null, '関西圏の外の検索結果は使わない');
let q = '';
await geocode('〇〇ホテル', async (url) => { if (/nominatim/.test(url)) q = url; return res([]); });
ok(/bounded=1/.test(q) && /viewbox=134,35\.9,136\.8,33\.3/.test(q), '施設名の検索は関西圏に絞る');

console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
