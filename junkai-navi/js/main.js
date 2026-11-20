import { EndlessNavigator } from './navcore.js?v=21';
import { ValhallaClient } from './valhalla.js?v=21';
import { DemandEngine, CAT_JA } from './demand.js?v=21';
import { fetchSpots, fetchWeather, fetchRailDisruption } from './sources.js?v=21';
import { sliceRoute, pointAt, haversine } from './geo.js?v=21';
import { decodeCsv, importAnalyzerCsv, placeKey, rideType, rideFilter, kindsLabel, DEFAULT_KINDS } from './csv.js?v=21';
import { profText, manualProf } from './profile.js?v=21';
import { EVENTS_URL, venueEvents } from './venues.js?v=21';
import { REGION_NAME, REGION_CENTER, VIEW_BOUNDS, MIN_ZOOM, inRegion, regionStyle } from './region.js?v=21';
import { geocode, geocodeAny, queryCandidates, centerOf, placesToCsv, csvToPlaces, mergePlaces, fmtStamp } from './places.js?v=21';

const $ = (id) => document.getElementById(id);
const STORE = 'endless-navi-v1';
const DEFAULT_CENTER = REGION_CENTER; // 三宮（関西圏の外の位置は使わない）

// ===== 設定の保存 =====
const cfg = Object.assign(
  {
    routerUrl: 'https://valhalla1.openstreetmap.de',
    radiusKm: 6,
    voice: true,
    simSpeed: 30,
    weatherMode: 'auto',
    railManual: false,
    odptKey: '',
    commitSec: 30,
    replanMin: 3,
    switchGain: 1.3,
    tourMax: 3, // 1回のルートで通る需要エリアの数
    revisitMin: 60, // 一度通ったエリアに、また向かうまでの時間（分）
    pickMode: 'nearest', // 行き先の選び方：nearest＝今いる所から近い需要エリア、demand＝需要の高さ優先
    sheetCollapsed: false, // 巡回中の表示エリアをたたんでいるか
    eco: false, // 省電力モード（平面の地図・解像度を下げる・短いアニメーション）
    autoEvents: true, // 神戸の主要会場のイベントを自動で需要に反映
    spots: [],
    spotsCenter: null,
    events: [],
    lastCenter: null,
    demandSource: 'manual', // manual: 任意で設定 / csv: タクシーアナライザのCSV
    csvRides: [],
    csvKinds: { ...DEFAULT_KINDS }, // 使う乗車の種類（初期は流しだけ。乗り場は除く）
    csvInfo: null,
    geoCache: {}, // 住所・施設名 → 位置（調べた結果を端末に残し、同じ場所を何度も調べない）
  },
  load()
);
function load() { try { const c = JSON.parse(localStorage.getItem(STORE)) || {}; delete c.csvStreetOnly; return c; } catch { return {}; } } // 旧設定は使わない（新しい初期値：乗り場を除く）
function save() { try { localStorage.setItem(STORE, JSON.stringify(cfg)); return true; } catch { return false; /* 容量超過など */ } }

// ===== 需要エンジン =====
const demand = new DemandEngine();
// 需要は「着くころ」の時刻で見る（エリアまで数分かかるので、少し先の需要で選ぶ）
const DEMAND_LEAD_MIN = 5;
const demandTime = () => new Date(Date.now() + DEMAND_LEAD_MIN * 60e3);

// ===== 神戸の主要会場のイベント（タクシーアナライザと共通の events.json を自動で読む） =====
const EV_KEY = 'endless-navi-venue-events';
let venueJson = (() => { try { return JSON.parse(localStorage.getItem(EV_KEY)); } catch { return null; } })();
async function refreshVenueEvents(force = false) {
  if (!cfg.autoEvents) return;
  if (!force && refreshVenueEvents.at && Date.now() - refreshVenueEvents.at < 30 * 60e3) return;
  refreshVenueEvents.at = Date.now();
  try {
    const r = await fetch(EVENTS_URL, { cache: 'no-cache' });
    if (r.ok) { venueJson = await r.json(); try { localStorage.setItem(EV_KEY, JSON.stringify(venueJson)); } catch { /* 容量 */ } }
  } catch { /* 圏外：前回の内容を使う */ }
}
const autoEvents = () => (cfg.autoEvents && venueJson ? venueEvents(venueJson) : []);
// 今日（と翌朝まで）のイベントの短い説明
function autoEventsText() {
  const list = autoEvents().filter((e) => new Date(e.end).getTime() > Date.now());
  if (!list.length) return cfg.autoEvents ? (venueJson ? '今日はこれからのイベントはありません' : 'イベント情報を読み込めていません') : '';
  const fmt = (e) => `${e.venue} ${new Date(e.end).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}終了`;
  return `これから ${list.length} 件（次：${fmt(list[0])}${list.length > 1 ? ' ほか' : ''}）`;
}

function syncDemand() {
  const manual = cfg.demandSource !== 'csv';
  demand.spots = manual ? cfg.spots.concat(cfg.events.filter((e) => e.kind === 'custom').map((e) => ({ ...e, cat: 'custom' }))) : [];
  demand.csvRides = manual ? [] : cfg.csvRides.filter(rideFilter(cfg.csvKinds));
  demand.events = cfg.events.filter((e) => e.kind !== 'custom' && new Date(e.end).getTime() > Date.now() - 2 * 3600e3).concat(autoEvents());
  demand.railDisruption = cfg.railManual || odptDisruption;
  if (cfg.weatherMode !== 'auto') demand.weather = cfg.weatherMode;
}
let odptDisruption = false;

// ===== Android アプリ（Capacitor）の中か =====
// WebView では読み上げ・画面点灯維持・リンクでの保存が使えないので、本体側のプラグイン（NaviDevice 等）で行う
const isNative = () => { const c = window.Capacitor; return !!(c && c.isNativePlatform && c.isNativePlatform() && c.nativePromise); };
const nativeCall = (plugin, method, args = {}) => window.Capacitor.nativePromise(plugin, method, args);

// ===== 音声 =====
let jaVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  jaVoice = vs.find((v) => v.lang === 'ja-JP' && /Kyoko|O-Ren|Google/.test(v.name)) || vs.find((v) => v.lang && v.lang.startsWith('ja')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, force = false) {
  if (!cfg.voice && !force) return;
  if (isNative()) { nativeCall('NaviDevice', 'speak', { text }).catch(() => {}); return; }
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  if (jaVoice) u.voice = jaVoice;
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ===== トースト =====
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ===== 地図 =====
// WebGL非対応などで地図を作れない場合も、案内（バナー・音声）は動くようにする
function createNullMap(center) {
  const el = document.getElementById('map');
  const layers = {}, vis = {}, srcs = {};
  return {
    on(ev, fn) { if (ev === 'load') setTimeout(fn, 0); },
    addControl() {},
    getStyle: () => ({ layers: [] }),
    getLayoutProperty: (id, p) => (p === 'visibility' ? vis[id] : null),
    setLayoutProperty: (id, p, v) => { if (p === 'visibility') vis[id] = v; },
    addSource: (id) => { srcs[id] = { setData() {} }; },
    getSource: (id) => srcs[id],
    addLayer: (l) => { layers[l.id] = l; },
    addImage() {},
    hasImage: () => true,
    getLayer: (id) => layers[id],
    getCanvasContainer: () => el,
    easeTo() {},
    getCenter: () => ({ toArray: () => center }),
    unproject: () => ({ lng: center[0], lat: center[1] }),
  };
}
const NullMarker = class { constructor() {} setLngLat() { return this; } addTo() { return this; } setRotation() { return this; } remove() {} };
let map, ML = window.maplibregl, mapError = null;
// 地図データは関西圏のタイルだけを読み込む（スタイルの読み込みに失敗した時は普通のスタイルで、地図を動かせる範囲だけ関西圏に）
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
let mapStyle = STYLE_URL;
if (ML) { try { mapStyle = await regionStyle(STYLE_URL); } catch { /* 普通のスタイル */ } }
const startCenter = cfg.lastCenter && inRegion(cfg.lastCenter[0], cfg.lastCenter[1]) ? cfg.lastCenter : DEFAULT_CENTER;
function mapPixelRatio() { return Math.min(window.devicePixelRatio || 1, cfg.eco ? 1.5 : 2); }
try {
  if (!ML) throw new Error('地図ライブラリを読み込めませんでした');
  map = new ML.Map({
    container: 'map',
    style: mapStyle,
    center: startCenter,
    maxBounds: VIEW_BOUNDS,
    minZoom: MIN_ZOOM,
    zoom: 14,
    attributionControl: false,
    pitchWithRotate: true,
    // 電池の節約：高解像度の画面でも描く細かさは2倍（省電力モードは1.5倍）まで。ラベルのフェード（描き直し）なし
    pixelRatio: mapPixelRatio(),
    fadeDuration: 0,
    refreshExpiredTiles: false,
  });
  map.addControl(new ML.AttributionControl({ compact: true }), 'bottom-right');
} catch (e) {
  mapError = /WebGL/i.test(String(e && (e.message || e))) ? 'この端末・ブラウザはWebGLに非対応' : (e.message || String(e));
  map = createNullMap(cfg.lastCenter || DEFAULT_CENTER);
  ML = { Marker: NullMarker };
}
const empty = { type: 'FeatureCollection', features: [] };
map.on('load', () => {
  // 地名を日本語優先に
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(layer.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name')) {
      map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:ja'], ['get', 'name']]);
    }
  }
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('heat', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'heat', type: 'heatmap', source: 'heat', layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'score'], 0, 0, 1.5, 1],
      // 案内中は拡大して見るので、拡大するほど強めに（需要の濃淡が見えるように）
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 1, 14, 1.8, 17, 3],
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 11, 25, 16, 160],
      'heatmap-opacity': 0.85,
      // オレンジ一色。需要が多いほど濃く（透明 → 薄いオレンジ → 濃いオレンジ）
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(255,152,0,0)', 0.1, 'rgba(255,183,77,0.3)', 0.35, 'rgba(255,152,0,0.5)', 0.65, 'rgba(245,124,0,0.68)', 1, 'rgba(230,81,0,0.85)'],
    },
  }, firstSymbol);
  // ルートは区間ごとに分けて描く：次のポイントまで（leg=0）は濃い青で太く上に、その先（leg>=1）は細く淡く下に。
  // 同じ交差点を2回通る時も、今進む線が上に見え、線上の矢印で向きがわかる。次の右左折は白い矢印で示す
  addArrowImages();
  map.addSource('route', { type: 'geojson', data: empty });
  map.addSource('turn', { type: 'geojson', data: empty });
  const lw = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, a, 18, b];
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
  map.addLayer({ id: 'route-later-casing', type: 'line', source: 'route', filter: ['>=', ['get', 'leg'], 1], layout: lineLayout, paint: { 'line-color': '#5b6f99', 'line-width': lw(5, 14), 'line-opacity': 0.55 } }, firstSymbol);
  map.addLayer({ id: 'route-later-line', type: 'line', source: 'route', filter: ['>=', ['get', 'leg'], 1], layout: lineLayout, paint: { 'line-color': '#a8c3f5', 'line-width': lw(3, 9), 'line-opacity': 0.85 } }, firstSymbol);
  map.addLayer({ id: 'route-later-arrows', type: 'symbol', source: 'route', filter: ['>=', ['get', 'leg'], 1],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'chev-later', 'icon-size': lw(0.35, 0.8), 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['get', 'leg'], 0], layout: lineLayout, paint: { 'line-color': '#0b57d0', 'line-width': lw(7, 22) } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['get', 'leg'], 0], layout: lineLayout, paint: { 'line-color': '#4c8df6', 'line-width': lw(4.5, 16) } });
  map.addLayer({ id: 'route-arrows', type: 'symbol', source: 'route', filter: ['==', ['get', 'leg'], 0],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 60, 'icon-image': 'chev-now', 'icon-size': lw(0.45, 1.1), 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' } });
  // 次の右左折：交差点の手前から曲がった先までの白い矢印
  map.addLayer({ id: 'turn-casing', type: 'line', source: 'turn', filter: ['==', ['geometry-type'], 'LineString'], layout: lineLayout, paint: { 'line-color': '#0b3d91', 'line-width': lw(6, 18) } });
  map.addLayer({ id: 'turn-line', type: 'line', source: 'turn', filter: ['==', ['geometry-type'], 'LineString'], layout: lineLayout, paint: { 'line-color': '#ffffff', 'line-width': lw(3, 10) } });
  map.addLayer({ id: 'turn-head', type: 'symbol', source: 'turn', filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'icon-image': 'turn-head', 'icon-size': lw(0.45, 1.2), 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  refreshHeat();
});
map.on('dragstart', () => { if (running) setFollow(false); });

// 線の上の矢印（シェブロン）と、右左折の矢じりの画像
function addArrowImages() {
  const make = (draw, size = 48) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d'); draw(x, size);
    return x.getImageData(0, 0, size, size);
  };
  // 右向き（線の進む向き）のシェブロン
  const chev = (fill, stroke) => make((x, s) => {
    x.lineJoin = 'round'; x.lineCap = 'round';
    x.beginPath(); x.moveTo(s * 0.32, s * 0.2); x.lineTo(s * 0.68, s * 0.5); x.lineTo(s * 0.32, s * 0.8);
    x.strokeStyle = stroke; x.lineWidth = s * 0.2; x.stroke();
    x.strokeStyle = fill; x.lineWidth = s * 0.1; x.stroke();
  });
  // 上向き（進む向き）の矢じり
  const head = make((x, s) => {
    x.beginPath(); x.moveTo(s * 0.5, s * 0.08); x.lineTo(s * 0.92, s * 0.72); x.lineTo(s * 0.08, s * 0.72); x.closePath();
    x.lineJoin = 'round'; x.strokeStyle = '#0b3d91'; x.lineWidth = s * 0.1; x.stroke(); x.fillStyle = '#fff'; x.fill();
  }, 64);
  try {
    map.addImage('chev-now', chev('#ffffff', '#0b57d0'), { pixelRatio: 2 });
    map.addImage('chev-later', chev('#5b6f99', '#ffffff'), { pixelRatio: 2 });
    map.addImage('turn-head', head, { pixelRatio: 2 });
  } catch { /* 地図が使えない端末 */ }
}

const puckEl = document.createElement('div');
puckEl.className = 'puck';
puckEl.innerHTML = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="#fff"/><path d="M24 7 37 38 24 31 11 38z" fill="#1a73e8"/></svg>';
const puck = new ML.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' });
// これから通るポイントの印（1＝次に通るポイント）。ゴールの印は出さない
let tourMarkers = [];
function drawTourMarkers(areas) {
  tourMarkers.forEach((m) => m.remove());
  tourMarkers = areas.map((a, i) => {
    const el = document.createElement('div');
    el.className = 'tour-dot' + (i === 0 ? ' next' : '');
    el.textContent = String(i + 1);
    return new ML.Marker({ element: el }).setLngLat(a.center).addTo(map);
  });
}

// ===== 案内アイコン =====
function arrowSVG(kind) {
  const left = kind.endsWith('left');
  const k = kind.replace('-left', '-right').replace(/^left$/, 'right');
  const paths = {
    straight: '<path d="M24 42V12" /><polygon points="13,20 24,6 35,20"/>',
    'slight-right': '<path d="M18 42V28L31 15" /><polygon points="24,10 38,8 36,22"/>',
    right: '<path d="M16 42V26q0-8 8-8h10" /><polygon points="32,8 44,18 32,28"/>',
    'sharp-right': '<path d="M16 42V12l14 18" /><polygon points="24,34 37,39 35,25"/>',
    uturn: '<path d="M16 42V20q0-10 10-10t10 10v10" /><polygon points="28,28 36,40 44,28"/>',
    roundabout: '<circle cx="24" cy="26" r="8" /><path d="M24 42V34M30 20l6-6" /><polygon points="30,8 42,8 42,20"/>',
  };
  const body = paths[k] || paths.straight;
  const flip = left ? ' transform="translate(48 0) scale(-1 1)"' : '';
  return `<svg viewBox="0 0 48 48"><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"${flip}>${body.replace(/<polygon/g, '<polygon fill="#fff" stroke="none"')}</g></svg>`;
}
function fmtDist(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

// ===== ナビ =====
let router = new ValhallaClient(cfg.routerUrl);
const nav = new EndlessNavigator({
  router: { route: (...a) => router.route(...a), matrix: (...a) => router.matrix(...a) },
  demand,
  settings: settingsForNav(),
  emit: (type, data) => {
    if (type === 'voice') { speak(data); }
    else if (type === 'status') { toast(data); }
    else if (type === 'pass') {
      const next = nav.tourRemaining()[0];
      speak(`${demand.areaName(data)}です${next ? `。次は${demand.areaName(next)}を通ります` : ''}`);
      drawRoute();
    }
    else if (type === 'route') {
      if (data.mode === 'switch') toast(`需要の変化に合わせて、${tourText(data.tour)}を通るルートに変えます`);
      if (data.mode === 'initial') speak(`巡回を開始します。${tourSpeech(data.tour)}`);
      drawRoute();
    }
  },
});
// 「三宮駅周辺 → 新神戸駅 → 北野」のような表示と、読み上げ用の文
const shortArea = (a) => (a && a.name) || '需要エリア';
function tourText(tour) {
  if (!tour || !tour.length) return '需要エリア';
  return [demand.areaName(tour[0]), ...tour.slice(1).map(shortArea)].join(' → ');
}
function tourSpeech(tour) {
  return `${(tour && tour.length ? tour : [null]).map((a) => demand.areaName(a)).join('、')}を通ります`;
}
function settingsForNav() {
  return { commitSec: +cfg.commitSec, replanMs: cfg.replanMin * 60e3, switchGain: +cfg.switchGain, radiusM: cfg.radiusKm * 1000, tourMax: Math.min(4, Math.max(1, +cfg.tourMax || 3)), revisitMin: Math.min(180, Math.max(15, +cfg.revisitMin || 60)), pickMode: cfg.pickMode === 'demand' ? 'demand' : 'nearest' };
}

let running = false, riding = false, simulate = false, follow = true;
let watchId = null, simTimer = null, loopTimer = null, demandTimer = null, wakeLock = null;
let lastFix = null, simPos = null;

function onFix(fix) {
  if (!onFix.warned && !inRegion(fix.point[0], fix.point[1])) { onFix.warned = true; toast(`現在地が${REGION_NAME}の外です。地図は${REGION_NAME}だけを読み込みます`, 6000); }
  lastFix = fix;
  cfg.lastCenter = fix.point;
  if (!riding) nav.update(fix);
  render();
}

function startGPS() {
  if (!('geolocation' in navigator)) { toast('この端末は位置情報に対応していません'); return; }
  watchId = navigator.geolocation.watchPosition(
    (p) => onFix({
      point: [p.coords.longitude, p.coords.latitude],
      speed: p.coords.speed,
      heading: p.coords.heading,
      accuracy: p.coords.accuracy,
      t: p.timestamp,
    }),
    (e) => toast(e.code === 1 ? '位置情報の利用を許可してください' : '現在地を取得できません'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function startSim() {
  simPos = cfg.lastCenter || map.getCenter().toArray();
  let simAlong = null;
  simTimer = setInterval(() => {
    const v = cfg.simSpeed / 3.6;
    if (nav.route && !riding) {
      simAlong = Math.max(simAlong ?? 0, nav.along) + v;
      const at = pointAt(nav.route, Math.min(simAlong, nav.route.length));
      simPos = at.point;
      if (simAlong >= nav.route.length) simAlong = nav.route.length;
      onFix({ point: simPos, speed: v, heading: at.bearing, accuracy: 5, t: Date.now() });
    } else {
      onFix({ point: simPos, speed: 0, heading: null, accuracy: 5, t: Date.now() });
    }
  }, 1000);
  // ルートが付け替わったら along が変わるので同期
  nav._origApply = nav._origApply || nav.apply.bind(nav);
  nav.apply = (...a) => { nav._origApply(...a); simAlong = nav.along; };
}

async function requestWakeLock() {
  if (isNative()) { nativeCall('NaviDevice', 'keepAwake', { on: true }).catch(() => {}); return; }
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* noop */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') { requestWakeLock(); render.cam = null; render(); } });

async function ensureSpots(center) {
  if (cfg.spots.length && cfg.spotsCenter && haversine(cfg.spotsCenter, center) < cfg.radiusKm * 500) return;
  toast('周辺の需要スポットを取得しています…', 8000);
  try {
    cfg.spots = await fetchSpots(center, cfg.radiusKm * 1000 + 1500);
    cfg.spotsCenter = center;
    save();
    toast(`需要スポットを ${cfg.spots.length} 件取得しました`);
  } catch (e) {
    toast(e.message + '。地図の長押しで地点を追加できます', 6000);
  }
}

async function refreshDemand() {
  const c = lastFix ? lastFix.point : cfg.lastCenter;
  if (cfg.weatherMode === 'auto' && c && (!refreshDemand.wAt || Date.now() - refreshDemand.wAt > 10 * 60e3)) {
    refreshDemand.wAt = Date.now();
    try { demand.weather = await fetchWeather(c); } catch { /* 前回値を維持 */ }
  }
  if (cfg.odptKey && (!refreshDemand.rAt || Date.now() - refreshDemand.rAt > 5 * 60e3)) {
    refreshDemand.rAt = Date.now();
    try { odptDisruption = (await fetchRailDisruption(cfg.odptKey)).length > 0; } catch { /* noop */ }
  }
  await refreshVenueEvents();
  syncDemand();
  demand.update(demandTime());
  refreshHeat();
  announceEvents();
}

// 近くの会場がまもなく終わる時に一度だけ知らせる（終了の20分前〜終了まで、営業エリアの中）
const announcedEv = new Set();
function announceEvents() {
  if (!running) return;
  const here = lastFix ? lastFix.point : cfg.lastCenter;
  const now = Date.now();
  for (const e of autoEvents()) {
    const end = new Date(e.end).getTime();
    if (now < end - 20 * 60e3 || now > end || announcedEv.has(e.id)) continue;
    if (here && haversine(here, [e.lng, e.lat]) > cfg.radiusKm * 1500) continue;
    announcedEv.add(e.id);
    const hm = new Date(end).toLocaleTimeString('ja-JP', { hour: 'numeric', minute: '2-digit' });
    toast(`${e.venue}：${hm}ごろ終了（${e.title}）`, 8000);
    speak(`${e.venue}が${hm}ごろ終わります`);
  }
}

function refreshHeat() {
  const src = map.getSource && map.getSource('heat');
  if (src) src.setData(demand.heatmapGeoJSON());
}

async function start(sim) {
  simulate = sim;
  // iOS は操作直後でないと読み上げできないため、ここで一度鳴らす
  speak(sim ? 'シミュレーションを開始します' : '現在地を確認しています', true);
  $('start').classList.add('hidden');
  ['banner', 'sheet'].forEach((id) => $(id).classList.remove('hidden'));
  running = true;
  riding = false;
  setFollow(true);
  nav.reset();
  nav.s = { ...nav.s, ...settingsForNav() };
  router = new ValhallaClient(cfg.routerUrl);
  requestWakeLock();

  const center = sim ? (cfg.lastCenter || map.getCenter().toArray()) : await firstPosition();
  cfg.lastCenter = center;
  syncDemand();
  demand.update(demandTime(), 1);
  nav.serviceCenter = center;
  // 位置の追跡はすぐ始め、需要スポット・天気の取得は裏で行う
  if (sim) startSim(); else startGPS();
  render();
  demandTimer = setInterval(refreshDemand, 60e3);
  loopTimer = setInterval(() => { save(); }, 30e3);
  if (cfg.demandSource === 'csv') {
    if (!demand.csvRides.length) toast('タクシーアナライザのCSVが読み込まれていません。設定から読み込んでください', 6000);
    refreshDemand();
  } else {
    ensureSpots(center).then(() => { syncDemand(); demand.update(demandTime(), 1); return refreshDemand(); });
  }
}

function firstPosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(cfg.lastCenter || DEFAULT_CENTER);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.longitude, p.coords.latitude]),
      () => { toast('現在地を取得できません。位置情報の許可を確認してください', 6000); resolve(cfg.lastCenter || DEFAULT_CENTER); },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });
}

function stop() {
  running = false;
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(simTimer); clearInterval(demandTimer); clearInterval(loopTimer);
  if (nav._origApply) { nav.apply = nav._origApply; delete nav._origApply; }
  watchId = simTimer = demandTimer = loopTimer = null;
  try { wakeLock && wakeLock.release(); } catch { /* noop */ }
  if (isNative()) nativeCall('NaviDevice', 'keepAwake', { on: false }).catch(() => {});
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  nav.reset();
  drawRoute();
  puck.remove(); drawTourMarkers([]); drawRoute.sig = null;
  ['banner', 'sheet', 'recenter'].forEach((id) => $(id).classList.add('hidden'));
  $('start').classList.remove('hidden');
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0 } });
  save();
  renderStart();
}

// 休止・再開（お客様を乗せている間は案内を止める。乗車の記録はタクシーアナライザで行い、ここでは何も記録しない）
function toggleRide() {
  if (!running) return;
  if (!riding) {
    riding = true;
    if (nav.target) demand.markVisited(nav.target.key);
    nav.route = null; nav.target = null; nav.tour = [];
    drawRoute();
    speak('案内を休止します');
  } else {
    riding = false;
    nav.reset();
    nav.s = { ...nav.s, ...settingsForNav() };
    nav.serviceCenter = lastFix ? lastFix.point : null;
    speak('巡回を再開します');
    if (lastFix) nav.update({ ...lastFix, t: Date.now() });
  }
  render();
}

// ===== 描画 =====
function setFollow(on) {
  follow = on;
  $('recenter').classList.toggle('hidden', on || !running);
}

function drawRoute() {
  const src = map.getSource && map.getSource('route');
  if (!src) return;
  if (!nav.route) { if (drawRoute.key !== 'none') { src.setData(empty); drawTourMarkers([]); drawRoute.sig = null; drawRoute.key = 'none'; drawTurnArrow(); } return; }
  // 電池の節約：ルート・通るポイントが同じで、進んだ距離が20m未満なら描き直さない
  if (!drawRoute.ids) drawRoute.ids = new WeakMap();
  if (!drawRoute.ids.has(nav.route)) drawRoute.ids.set(nav.route, (drawRoute.n = (drawRoute.n || 0) + 1));
  const key = `${drawRoute.ids.get(nav.route)}|${Math.floor(nav.along / 20)}|${nav.tour.filter((x) => !x.passed).map((x) => x.area.key + '@' + Math.round(x.at)).join(',')}`;
  drawTurnArrow();
  if (key === drawRoute.key) return;
  drawRoute.key = key;
  // 区間ごとに分ける：今いる所 → 次のポイント（leg=0）、その先は次のポイントごとに leg=1,2,…
  const cuts = nav.tour.filter((x) => !x.passed && x.at > nav.along + 5).map((x) => x.at).sort((a, b) => a - b);
  const edges = [nav.along, ...cuts.filter((a) => a < nav.route.length - 5), nav.route.length];
  const features = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const c = sliceRoute(nav.route, edges[i], edges[i + 1]);
    if (c.length >= 2) features.push({ type: 'Feature', properties: { leg: i }, geometry: { type: 'LineString', coordinates: c } });
  }
  // 遠い区間を先に（下に）描く
  src.setData({ type: 'FeatureCollection', features: features.reverse() });
  const upcoming = nav.tourRemaining();
  const sig = upcoming.map((a) => a.key).join('|');
  if (sig !== drawRoute.sig) { drawRoute.sig = sig; drawTourMarkers(upcoming); }
}

// 次の右左折（600m以内）に、手前40mから曲がった先30mまでの白い矢印を出す
function drawTurnArrow() {
  const src = map.getSource && map.getSource('turn');
  if (!src) return;
  const next = nav.route && nav.nextActions()[0];
  // 電池の節約：矢印が変わらない時（遠い・10m未満しか進んでいない）は描き直さない
  const key = !next || next.at - nav.along > 600 ? 'none' : `${next.at}|${Math.floor(nav.along / 10)}`;
  if (key === drawTurnArrow.key) return;
  drawTurnArrow.key = key;
  if (key === 'none') { src.setData(empty); return; }
  const from = Math.max(nav.along, next.at - 40), to = Math.min(nav.route.length, next.at + 30);
  const line = sliceRoute(nav.route, from, to);
  const tip = pointAt(nav.route, to);
  src.setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
    { type: 'Feature', properties: { rot: tip.bearing }, geometry: { type: 'Point', coordinates: tip.point } },
  ] });
}

function render() {
  if (!running) return;
  if (document.visibilityState === 'hidden') return; // 見えていない間は描かない（案内・音声は続ける）
  const fix = lastFix;
  if (fix) {
    puck.setLngLat(fix.point).addTo(map);
    const hd = nav.heading ?? 0;
    puck.setRotation(hd);
    if (follow && document.visibilityState !== 'hidden') {
      const kmh = (nav.speed || 0) * 3.6;
      const zoom = kmh > 50 ? 15.6 : kmh > 25 ? 16.3 : 17;
      // 電池の節約：止まっている・ほとんど動いていない時は地図を動かさない（描き直しを止める）。
      // アニメーションは次の位置が来る前に終わる長さにして、その間は地図を休ませる
      const c = render.cam;
      const pitch = cfg.eco ? 0 : 55;
      const moved = !c || haversine(c.p, fix.point) > 4 || Math.abs(((hd - c.b + 540) % 360) - 180) > 4 || c.z !== zoom || c.pitch !== pitch || c.col !== cfg.sheetCollapsed;
      if (moved) {
        render.cam = { p: fix.point, b: hd, z: zoom, pitch, col: cfg.sheetCollapsed };
        map.easeTo({
          center: fix.point, bearing: hd, pitch, zoom,
          padding: { top: window.innerHeight * (cfg.eco ? 0.3 : 0.38), bottom: cfg.sheetCollapsed ? 60 : 170 },
          duration: cfg.eco ? 300 : 600, easing: (t) => t,
        });
      }
    }
  }
  drawRoute();

  const v = nav.view();
  if (riding) {
    $('b-icon').innerHTML = arrowSVG('straight');
    $('b-dist').textContent = '休止中';
    $('b-street').textContent = '「再開」を押すと、今いる所から巡回を再開します';
    $('b-then').classList.add('hidden');
    $('s-mode').textContent = '休止中'; $('s-mode').classList.add('riding');
    $('s-target').textContent = '';
    $('s-meta').textContent = '案内を止めています（乗車の記録はタクシーアナライザで）';
    $('s-level').textContent = '';
    $('btn-ride-label').textContent = '再開';
    $('btn-ride').classList.add('riding');
    return;
  }
  $('s-mode').textContent = '巡回中'; $('s-mode').classList.remove('riding');
  $('btn-ride-label').textContent = '休止';
  $('btn-ride').classList.remove('riding');
  if (!v) {
    $('b-icon').innerHTML = arrowSVG('straight');
    $('b-dist').textContent = nav.planning ? 'ルートを計算中' : '現在地を確認中';
    $('b-street').textContent = '';
    $('s-target').textContent = '需要エリアを計算中…';
    $('s-meta').textContent = '';
    $('s-level').textContent = '';
    return;
  }
  if (v.next) {
    $('b-icon').innerHTML = arrowSVG(v.next.kind);
    $('b-dist').textContent = fmtDist(v.nextDist);
    $('b-street').textContent = v.next.street ? `${v.next.ja}・${v.next.street}` : v.next.ja;
  } else {
    $('b-icon').innerHTML = arrowSVG('straight');
    $('b-dist').textContent = fmtDist(v.nextDist);
    $('b-street').textContent = '道なりに進む';
  }
  if (v.then) { $('b-then').classList.remove('hidden'); $('b-then-icon').innerHTML = arrowSVG(v.then.kind); }
  else $('b-then').classList.add('hidden');
  // ゴールは無いので、残り距離・到着時刻は出さず「次に通るポイント」を出す
  $('s-target').textContent = v.tour && v.tour.length ? `次：${tourText(v.tour.slice(0, 2))}${v.tour.length > 2 ? ` ほか${v.tour.length - 2}` : ''}` : '次のポイントを計算中…';
  $('s-meta').textContent = `${v.nextPointDist != null ? `次のポイントまで ${fmtDist(v.nextPointDist)} ・ ` : ''}${weatherJa()}`;
  const lv = demand.level(v.target && demand.areas.get(v.target.key));
  $('s-level').textContent = '需要 ' + '●'.repeat(lv) + '○'.repeat(5 - lv);
}
const weatherJa = () => ({ clear: '晴れ', rain: '雨', heavy: '大雨' }[demand.weather] || '') + (demand.railDisruption ? '・鉄道遅延' : '');

const evLine = () => (cfg.autoEvents && autoEventsText() ? `<br>会場イベント：${autoEventsText()}` : '');
function renderStart() {
  if (cfg.demandSource === 'csv') {
    const n = cfg.csvRides.filter(rideFilter(cfg.csvKinds)).length;
    $('spot-info').innerHTML = cfg.csvRides.length
      ? `需要エリア：タクシーアナライザのCSV<br>乗車実績 ${n} 件（${kindsLabel(cfg.csvKinds)}）${evLine()}`
      : `需要エリア：タクシーアナライザのCSV<br>設定からCSVを読み込んでください${evLine()}`;
    return;
  }
  const n = cfg.spots.length;
  const cats = {};
  for (const s of cfg.spots) cats[s.cat] = (cats[s.cat] || 0) + 1;
  const detail = Object.entries(cats).map(([k, c]) => `${CAT_JA[k]} ${c}`).join('・');
  const custom = cfg.events.filter((e) => e.kind === 'custom').length;
  $('spot-info').innerHTML = (n || custom
    ? `需要エリア：任意で設定<br>需要スポット ${n} 件${detail ? `（${detail}）` : ''}${custom ? `・登録地点 ${custom} 件` : ''}`
    : '需要エリア：任意で設定<br>開始すると現在地の周辺から駅・ホテル・病院・繁華街などを自動で取得します') + evLine();
}

// ===== 地図の長押しで地点追加 =====
let pressTimer = null, pressPoint = null, pendingLngLat = null;
map.getCanvasContainer().addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  pressPoint = [t.clientX, t.clientY];
  pressTimer = setTimeout(() => openAddPoint(pressPoint), 650);
}, { passive: true });
map.getCanvasContainer().addEventListener('touchmove', (e) => {
  if (!pressPoint) return;
  const t = e.touches[0];
  if (Math.hypot(t.clientX - pressPoint[0], t.clientY - pressPoint[1]) > 10) clearTimeout(pressTimer);
}, { passive: true });
map.getCanvasContainer().addEventListener('touchend', () => clearTimeout(pressTimer));
map.on('contextmenu', (e) => openAddPoint([e.point.x, e.point.y], e.lngLat));
function openAddPoint(px, lngLat) {
  pendingLngLat = lngLat || map.unproject(px);
  const end = new Date(Date.now() + 2 * 3600e3);
  $('ap-end').value = `${String(end.getHours()).padStart(2, '0')}:00`;
  $('ap-name').value = '';
  $('addpoint').classList.remove('hidden');
}
document.querySelectorAll('input[name=ap-kind]').forEach((r) => r.addEventListener('change', () => {
  $('ap-event').classList.toggle('hidden', document.querySelector('input[name=ap-kind]:checked').value !== 'event');
}));
$('ap-save').onclick = () => {
  const kind = document.querySelector('input[name=ap-kind]:checked').value;
  const name = $('ap-name').value.trim() || (kind === 'event' ? 'イベント会場' : '登録地点');
  const item = { id: 'u' + Date.now(), name, lng: pendingLngLat.lng, lat: pendingLngLat.lat, kind };
  if (kind === 'event') {
    const [h, m] = ($('ap-end').value || '21:00').split(':').map(Number);
    const end = new Date(); end.setHours(h, m, 0, 0);
    if (end.getTime() < Date.now() - 3600e3) end.setDate(end.getDate() + 1);
    item.end = end.toISOString();
    item.size = $('ap-size').value;
  }
  cfg.events.push(item);
  save();
  $('addpoint').classList.add('hidden');
  toast(kind === 'event' ? `「${name}」を追加しました（終了前後に需要が上がります）` : `「${name}」を需要地点に追加しました${cfg.demandSource === 'csv' ? '（「任意で設定」のときに使われます）' : ''}`);
  syncDemand(); demand.update(demandTime()); refreshHeat(); renderEvents();
};

// ===== 設定画面 =====
function openSettings() {
  $('set-spots').textContent = `取得済み ${cfg.spots.length} 件`;
  document.querySelectorAll('input[name=set-source]').forEach((r) => (r.checked = r.value === cfg.demandSource));
  document.querySelectorAll('input[name=set-kind]').forEach((c) => (c.checked = !!cfg.csvKinds[c.value]));
  showSourcePanels();
  $('set-radius').value = cfg.radiusKm;
  $('set-weather').value = cfg.weatherMode;
  $('set-rail').checked = cfg.railManual;
  $('set-odpt').value = cfg.odptKey;
  $('set-voice').checked = cfg.voice;
  $('set-commit').value = cfg.commitSec;
  $('set-replan').value = cfg.replanMin;
  $('set-gain').value = cfg.switchGain;
  $('set-tour').value = cfg.tourMax;
  $('set-revisit').value = cfg.revisitMin;
  $('set-eco').checked = !!cfg.eco;
  $('set-auto-ev').checked = !!cfg.autoEvents;
  $('set-auto-ev-info').textContent = autoEventsText();
  document.querySelectorAll('input[name=set-pick]').forEach((r) => (r.checked = r.value === (cfg.pickMode === 'demand' ? 'demand' : 'nearest')));
  $('set-router').value = cfg.routerUrl;
  $('set-sim').value = cfg.simSpeed;
  renderEvents();
  $('settings').classList.remove('hidden');
}
// 設定画面のボタンに件数を出す（一覧そのものは「登録地点」の画面）
function renderEvents() {
  $('btn-places').textContent = `登録地点の一覧を開く（${cfg.events.length}件）`;
  if (!$('places').classList.contains('hidden')) renderPlaces();
}

// ===== 施設名・住所から位置を調べる（CSVの読み込み用） =====
// list: [{ q: [候補…] }]。住所（市区町村を含む）を先に調べ、その中心の近くに絞って施設名だけのものを調べる
const looksAddr = (q) => /[都道府県市区町村]/.test(q);
async function resolveMany(list, label) {
  const first = list.filter((x) => x.q.some(looksAddr)), rest = list.filter((x) => !x.q.some(looksAddr));
  let done = 0;
  const step = async (x, near) => {
    toast(`${label}… ${++done}/${list.length}`, 60000);
    const hit = await geocodeAny(x.q, cfg.geoCache, { near, maxKm: 60, wait: 250 });
    if (hit) { x.lat = hit.lat; x.lng = hit.lng; }
  };
  for (const x of first) await step(x, null);
  const near = centerOf(first.concat(cfg.events)) || (cfg.lastCenter && cfg.lastCenter !== DEFAULT_CENTER ? cfg.lastCenter : null);
  for (const x of rest) await step(x, near);
  save();
  return list.filter((x) => x.lat == null);
}

// ===== 登録地点の一覧（住所から追加・編集・削除、CSV） =====
let plEditId = null;    // 編集中の地点のID（新規は null）
let plFound = null;     // 住所から見つかった位置 {lat,lng,title,addr}
const plKind = () => document.querySelector('input[name=pl-kind]:checked').value;
const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function placesChanged() {
  save(); syncDemand(); demand.update(demandTime()); refreshHeat(); renderStart(); renderEvents(); renderPlaces();
}
function openPlaces() {
  closePlaceForm();
  renderPlaces();
  $('places').classList.remove('hidden');
}
function renderPlaces() {
  const box = $('pl-list');
  $('pl-count').textContent = `${cfg.events.length}件`;
  box.innerHTML = '';
  if (!cfg.events.length) {
    box.innerHTML = '<div class="pl-empty">まだ登録がありません。「住所から追加」かCSVの読み込みで登録できます。</div>';
    return;
  }
  // 常設 → 開催予定のイベント（終了が早い順）→ 終了したイベント
  const now = Date.now();
  const order = (e) => (e.kind !== 'event' ? 0 : new Date(e.end).getTime() >= now ? 1 : 2);
  const list = cfg.events.slice().sort((a, b) => order(a) - order(b) || (order(a) ? new Date(a.end) - new Date(b.end) : (b.rides || 0) - (a.rides || 0)));
  for (const ev of list) {
    const past = ev.kind === 'event' && new Date(ev.end).getTime() < now;
    const item = document.createElement('div');
    item.className = 'pl-item' + (past ? ' past' : '');
    const badge = ev.kind !== 'event' ? `<span class="pl-badge">${ev.rides ? `乗車 ${ev.rides}回` : '常設'}</span>`
      : `<span class="pl-badge ev${past ? ' past' : ''}">${past ? '終了' : 'イベント'} ${fmtStamp(ev.end).slice(5)}</span>`;
    item.innerHTML = `<div class="pl-top"><span class="pl-name"></span>${badge}</div><div class="pl-addr"></div>${ev.kind !== 'event' && profText(ev.prof) ? '<div class="pl-prof"></div>' : ''}
      <div class="pl-btns">${running ? '<button data-a="map">地図</button>' : ''}<button data-a="edit">編集</button><button data-a="del" class="del">削除</button></div>`;
    item.querySelector('.pl-name').textContent = ev.name;
    item.querySelector('.pl-addr').textContent = ev.addr || '地図の長押しで追加（住所なし）';
    if (item.querySelector('.pl-prof')) item.querySelector('.pl-prof').textContent = '🕒 ' + profText(ev.prof);
    if (running) item.querySelector('[data-a=map]').onclick = () => {
      $('places').classList.add('hidden'); $('settings').classList.add('hidden');
      if (running) setFollow(false);
      map.easeTo({ center: [ev.lng, ev.lat], zoom: 16, duration: 600 });
      toast(`「${ev.name}」の位置です`);
    };
    item.querySelector('[data-a=edit]').onclick = () => openPlaceForm(ev);
    item.querySelector('[data-a=del]').onclick = () => {
      if (!confirm(`「${ev.name}」を削除しますか？`)) return;
      cfg.events = cfg.events.filter((x) => x.id !== ev.id);
      if (plEditId === ev.id) closePlaceForm();
      placesChanged();
      toast(`「${ev.name}」を削除しました`);
    };
    box.appendChild(item);
  }
}
function openPlaceForm(ev) {
  plEditId = ev ? ev.id : null;
  plFound = ev && ev.lat != null ? { lat: ev.lat, lng: ev.lng, title: null, addr: ev.addr || '' } : null;
  $('pl-form-title').textContent = ev ? '登録地点を編集' : '住所から追加';
  $('pl-name').value = ev ? ev.name : '';
  $('pl-addr').value = ev ? ev.addr || '' : '';
  const kind = ev ? (ev.kind === 'event' ? 'event' : 'custom') : 'custom';
  document.querySelectorAll('input[name=pl-kind]').forEach((r) => (r.checked = r.value === kind));
  $('pl-event').classList.toggle('hidden', kind !== 'event');
  $('pl-time').classList.toggle('hidden', kind === 'event');
  // 自分で指定した時間帯・曜日を表示（ひと続きの時間帯だけ。営業ログ由来は「指定なし」のまま）
  const mp = ev && ev.prof && ev.prof.src === 'manual' ? ev.prof : null;
  let h1 = '', h2 = '24';
  if (mp && !mp.h.every(Boolean)) {
    const start = mp.h.findIndex((v, i) => v && !mp.h[(i + 23) % 24]);
    if (start >= 0) { let e = start; while (mp.h[e % 24] && e < start + 24) e++; h1 = String(start); h2 = String(e % 24 || 24); }
  }
  $('pl-h1').value = h1; $('pl-h2').value = h2;
  document.querySelectorAll('#pl-days input').forEach((c) => (c.checked = mp ? !!mp.d[+c.value] : true));
  $('pl-time-hint').dataset.log = ev && ev.prof && ev.prof.src === 'log' ? '1' : '';
  $('pl-end').value = toLocalInput(ev && ev.end ? ev.end : Date.now() + 3 * 3600e3);
  $('pl-size').value = ev && ev.size ? ev.size : 'm';
  $('pl-found').classList.add('hidden');
  $('pl-form').classList.remove('hidden');
  $('pl-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  (ev ? $('pl-name') : $('pl-addr')).focus();
}
function closePlaceForm() { plEditId = null; plFound = null; $('pl-form').classList.add('hidden'); }
document.querySelectorAll('input[name=pl-kind]').forEach((r) => r.addEventListener('change', () => {
  $('pl-event').classList.toggle('hidden', plKind() !== 'event');
  $('pl-time').classList.toggle('hidden', plKind() === 'event');
}));
// フォームの時間帯・曜日 → プロファイル（どちらも指定なしなら null）
function formProf() {
  const h1 = $('pl-h1').value;
  let hours = null;
  if (h1 !== '') {
    hours = Array(24).fill(0);
    const a = +h1, end = +$('pl-h2').value % 24;
    if (a === end) hours.fill(1); else for (let h = a; h !== end; h = (h + 1) % 24) hours[h] = 1;
  }
  const days = Array(7).fill(0);
  document.querySelectorAll('#pl-days input').forEach((c) => { if (c.checked) days[+c.value] = 1; });
  return manualProf(hours, days.every(Boolean) ? null : days);
}
$('pl-addr').addEventListener('input', () => $('pl-found').classList.add('hidden'));
$('pl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addr = $('pl-addr').value.trim();
  const old = plEditId ? cfg.events.find((x) => x.id === plEditId) : null;
  // 住所が変わった時（新規を含む）だけ調べ直す。住所なしの地点（地図で追加）は位置をそのまま使う
  let pos = old && (old.addr || '') === addr && old.lat != null ? { lat: old.lat, lng: old.lng } : null;
  if (!pos) {
    if (!addr) { toast('住所を入力してください'); $('pl-addr').focus(); return; }
    const btn = $('pl-save'); btn.disabled = true; btn.textContent = '住所を調べています…';
    let hit = null, offline = false;
    try { hit = await geocode(addr, undefined, { near: centerOf(cfg.events) }); } catch { offline = true; }
    btn.disabled = false; btn.textContent = '住所を調べて保存';
    if (offline) { toast('住所を調べられませんでした。通信できる場所でもう一度お試しください', 6000); return; }
    if (!hit) { toast('住所が見つかりませんでした。番地や市区町村を確かめてください', 6000); return; }
    pos = hit;
    $('pl-found').textContent = `見つかった場所：${hit.title}`;
    $('pl-found').classList.remove('hidden');
  }
  const kind = plKind();
  const item = { id: old ? old.id : 'u' + Date.now(), name: $('pl-name').value.trim() || addr || (kind === 'event' ? 'イベント会場' : '登録地点'), addr, lat: +(+pos.lat).toFixed(6), lng: +(+pos.lng).toFixed(6), kind };
  if (kind === 'custom') {
    const fp = formProf();
    if (fp && !fp.d.some(Boolean)) { toast('曜日を1つ以上選んでください'); return; }
    // 指定なしなら、営業ログ由来の傾向はそのまま残す
    const prof = fp || (old && old.prof && old.prof.src === 'log' ? old.prof : null);
    if (prof) item.prof = prof;
    if (old && old.rides) { item.rides = old.rides; item.fromLog = old.fromLog; }
  }
  if (kind === 'event') {
    const end = $('pl-end').value ? new Date($('pl-end').value) : null;
    if (!end || isNaN(end)) { toast('終了日時を入力してください'); return; }
    item.end = end.toISOString();
    item.size = $('pl-size').value;
  }
  if (old) cfg.events = cfg.events.map((x) => (x.id === old.id ? item : x));
  else cfg.events.push(item);
  closePlaceForm();
  placesChanged();
  toast(`「${item.name}」を${old ? '更新' : '追加'}しました${pos.title ? `（${pos.title}）` : ''}${kind === 'custom' && cfg.demandSource === 'csv' ? '。常設の地点は「任意で設定」のときに使われます' : ''}`, 5000);
});
$('pl-cancel').onclick = closePlaceForm;
$('pl-add').onclick = () => openPlaceForm(null);
$('btn-places').onclick = openPlaces;
$('pl-export').onclick = () => {
  if (!cfg.events.length) { toast('登録地点がありません'); return; }
  const d = new Date();
  const name = `junkai-navi_places_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
  const body = placesToCsv(cfg.events);
  // アプリの中では「ダウンロード/巡回ナビ」に直接保存（できない古い Android では共有メニューから保存先を選ぶ）
  if (isNative()) {
    const share = () => nativeCall('Filesystem', 'writeFile', { path: name, data: body, directory: 'CACHE', encoding: 'utf8' })
      .then((r) => nativeCall('Share', 'share', { title: name, files: [r.uri] }))
      .catch((e) => { if (!/cancel/i.test(String(e && e.message))) toast('保存できませんでした'); });
    nativeCall('NaviDevice', 'saveDownload', { name, data: body, mime: 'text/csv' })
      .then(() => toast(`${cfg.events.length}件を「ダウンロード/巡回ナビ」に保存しました`))
      .catch(share);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast(`${cfg.events.length}件をCSVで保存しました`);
};
$('pl-csv').addEventListener('change', async () => {
  const f = $('pl-csv').files[0];
  $('pl-csv').value = '';
  if (!f) return;
  try {
    const { items, errors, analyzer } = csvToPlaces(decodeCsv(await f.arrayBuffer()), { kinds: cfg.csvKinds });
    // 緯度・経度が無い行は、住所（無ければ施設名）から調べる。結果は端末に残すので、2回目からは速い
    const need = items.filter((it) => it.lat == null);
    need.forEach((it) => { if (!it.q) it.q = queryCandidates(it.name, it.addr); });
    const missedItems = await resolveMany(need, analyzer ? '乗車した場所の位置を調べています' : '住所から位置を調べています');
    const missed = missedItems.map((it) => it.name);
    items.forEach((it) => delete it.q);
    const ok = items.filter((it) => it.lat != null);
    if (!ok.length) throw new Error(errors[0] || (missed.length ? `住所が見つかりませんでした（${missed.slice(0, 3).join('、')}）` : '読み込める行がありません'));
    const { list, added, updated, removed } = mergePlaces(cfg.events, ok, undefined, { replaceLog: !!analyzer });
    cfg.events = list;
    placesChanged();
    const skip = errors.length + missed.length;
    toast(`${analyzer ? `営業ログの乗車 ${analyzer.used}件（${kindsLabel(cfg.csvKinds)}）から、乗車した場所 ` : ''}追加 ${added}件・更新 ${updated}件${removed ? `・対象外になった地点 ${removed}件を削除` : ''}${skip ? `・読み込めなかった行 ${skip}件（${errors.concat(missed.map((m) => `${m}：住所が見つからない`)).slice(0, 2).join('／')}${skip > 2 ? ' ほか' : ''}）` : ''}`, 8000);
  } catch (e) {
    toast(e.message, 6000);
  }
});

const bind = (id, key, conv = (v) => v, prop = 'value') => $(id).addEventListener('change', () => {
  cfg[key] = conv($(id)[prop]);
  save();
  syncDemand();
  nav.s = { ...nav.s, ...settingsForNav() };
  if (key === 'routerUrl') router = new ValhallaClient(cfg.routerUrl);
  if (key === 'weatherMode') refreshDemand.wAt = 0;
  if (key === 'odptKey') refreshDemand.rAt = 0;
});
bind('set-radius', 'radiusKm', Number);
bind('set-weather', 'weatherMode');
bind('set-rail', 'railManual', Boolean, 'checked');
bind('set-odpt', 'odptKey', (v) => v.trim());
bind('set-voice', 'voice', Boolean, 'checked');
bind('set-commit', 'commitSec', Number);
bind('set-replan', 'replanMin', Number);
bind('set-gain', 'switchGain', Number);
document.querySelectorAll('input[name=set-pick]').forEach((r) => r.addEventListener('change', () => { cfg.pickMode = r.value; save(); nav.s = { ...nav.s, ...settingsForNav() }; }));
$('set-auto-ev').addEventListener('change', async () => {
  cfg.autoEvents = $('set-auto-ev').checked; save();
  if (cfg.autoEvents) await refreshVenueEvents(true);
  $('set-auto-ev-info').textContent = autoEventsText();
  syncDemand(); demand.update(demandTime()); refreshHeat(); renderStart();
});
$('set-eco').addEventListener('change', () => {
  cfg.eco = $('set-eco').checked; save();
  document.body.classList.toggle('eco', cfg.eco);
  try { if (map.setPixelRatio) map.setPixelRatio(mapPixelRatio()); } catch { /* 古い地図ライブラリ */ }
  render.cam = null; if (running) render();
});
document.body.classList.toggle('eco', !!cfg.eco);
bind('set-revisit', 'revisitMin', (v) => Math.min(180, Math.max(15, Math.round(Number(v)) || 60)));
bind('set-tour', 'tourMax', (v) => Math.min(4, Math.max(1, Math.round(Number(v)) || 3)));
bind('set-router', 'routerUrl', (v) => v.trim() || 'https://valhalla1.openstreetmap.de');
bind('set-sim', 'simSpeed', Number);

// ===== 需要エリアの入力方法 =====
function showSourcePanels() {
  const csv = cfg.demandSource === 'csv';
  $('src-manual').classList.toggle('hidden', csv);
  $('src-csv').classList.toggle('hidden', !csv);
  const info = cfg.csvInfo;
  $('set-csv').textContent = cfg.csvRides.length && info
    ? `読み込み済み：乗車 ${cfg.csvRides.length} 件（${info.from}〜${info.to}）・内訳 ${kindCounts()}・使う乗車 ${cfg.csvRides.filter(rideFilter(cfg.csvKinds)).length} 件${info.skipped ? `・場所がわからない ${info.skipped} 件は除外` : ''}`
    : 'まだ読み込まれていません';
}
function applyDemandChange() {
  save(); syncDemand(); demand.areas = new Map(); demand.update(demandTime(), 1); refreshHeat(); renderStart();
}
document.querySelectorAll('input[name=set-source]').forEach((r) => r.addEventListener('change', () => {
  cfg.demandSource = r.value;
  showSourcePanels();
  applyDemandChange();
}));
function kindCounts() {
  const c = { street: 0, stand: 0, app: 0 };
  for (const r of cfg.csvRides) c[rideType(r)]++;
  return `流し ${c.street}・乗り場 ${c.stand}・アプリ等 ${c.app}`;
}
document.querySelectorAll('input[name=set-kind]').forEach((c) => c.addEventListener('change', () => {
  cfg.csvKinds = { ...cfg.csvKinds, [c.value]: c.checked };
  applyDemandChange(); showSourcePanels();
  if (!Object.values(cfg.csvKinds).some(Boolean)) toast('使う乗車の種類を1つ以上選んでください');
}));
$('csv-file').addEventListener('change', async () => {
  const f = $('csv-file').files[0];
  $('csv-file').value = '';
  if (!f) return;
  try {
    const parsed = importAnalyzerCsv(decodeCsv(await f.arrayBuffer()));
    const { total } = parsed;
    let { rides, skipped } = parsed;
    if (!rides.length) throw new Error(total ? '乗車記録に位置も施設名・住所もありません' : '乗車記録がありません');
    // 施設・手入力で記録した乗車は緯度・経度が空なので、施設名・住所から位置を調べる（同じ場所は1回だけ）
    const groups = new Map();
    for (const r of rides) if (r.lat == null) {
      const k = placeKey(r);
      if (!groups.has(k)) groups.set(k, { q: queryCandidates(r.fac, r.addr), rides: [] });
      groups.get(k).rides.push(r);
    }
    if (groups.size) {
      const missed = await resolveMany([...groups.values()], '乗車した場所の位置を調べています');
      for (const g of groups.values()) if (g.lat != null) g.rides.forEach((r) => { r.lat = g.lat; r.lng = g.lng; });
      const before = rides.length;
      rides = rides.filter((r) => r.lat != null);
      skipped += before - rides.length;
      if (!rides.length) throw new Error(`乗車した場所の位置を調べられませんでした（${missed.length}か所）。通信を確認してください`);
    }
    const d = (t) => new Date(t).toLocaleDateString('ja-JP');
    cfg.csvRides = rides.map((r) => ({ lng: +r.lng.toFixed(6), lat: +r.lat.toFixed(6), t: r.t, name: r.name, fare: r.fare, kind: r.kind, app: r.app }));
    cfg.csvInfo = { file: f.name, from: d(rides[0].t), to: d(rides[rides.length - 1].t), skipped };
    cfg.demandSource = 'csv';
    document.querySelectorAll('input[name=set-source]').forEach((x) => (x.checked = x.value === 'csv'));
    applyDemandChange();
    showSourcePanels();
    toast(save() ? `乗車実績 ${rides.length} 件を読み込みました` : `乗車実績 ${rides.length} 件を読み込みました（件数が多く端末に保存できないため、次回起動時は読み込み直しが必要です）`, 6000);
  } catch (e) {
    toast(e.message, 6000);
  }
});
let clearCsvArmed = 0;
$('btn-clear-csv').onclick = () => {
  if (Date.now() - clearCsvArmed > 4000) { clearCsvArmed = Date.now(); toast('もう一度押すと読み込んだCSVを消去します'); return; }
  cfg.csvRides = []; cfg.csvInfo = null; applyDemandChange(); showSourcePanels(); toast('CSVのデータを消去しました');
};

$('btn-fetch').onclick = async () => {
  const c = lastFix ? lastFix.point : await firstPosition();
  cfg.spotsCenter = null;
  await ensureSpots(c);
  $('set-spots').textContent = `取得済み ${cfg.spots.length} 件`;
  syncDemand(); demand.update(demandTime(), 1); refreshHeat(); renderStart();
};
$('btn-clear-spots').onclick = () => { cfg.spots = []; cfg.spotsCenter = null; save(); $('set-spots').textContent = '取得済み 0 件'; renderStart(); };
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => $(b.dataset.close).classList.add('hidden')));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

// ===== 巡回中の表示エリア：下にスワイプでたたむ、上にスワイプ（または取っ手をタップ）で開く =====
function setSheetCollapsed(on) {
  cfg.sheetCollapsed = !!on; save();
  $('sheet').classList.toggle('collapsed', cfg.sheetCollapsed);
  document.body.classList.toggle('sheet-collapsed', cfg.sheetCollapsed);
}
(() => {
  const sheet = $('sheet');
  let y0 = null, dy = 0, moved = false;
  const down = (y) => { y0 = y; dy = 0; moved = false; sheet.classList.add('dragging'); };
  const move = (y) => {
    if (y0 == null) return;
    dy = y - y0;
    if (Math.abs(dy) > 6) moved = true;
    // たたむ方向（下）だけ指についてくる
    sheet.style.transform = dy > 0 && !cfg.sheetCollapsed ? `translateY(${dy}px)` : '';
  };
  const up = () => {
    if (y0 == null) return;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    if (dy > 40) setSheetCollapsed(true);
    else if (dy < -40) setSheetCollapsed(false);
    y0 = null;
  };
  // ボタンの上から始まった操作も、上下に動かしたらスワイプとして扱う
  sheet.addEventListener('touchstart', (e) => down(e.touches[0].clientY), { passive: true });
  sheet.addEventListener('touchmove', (e) => move(e.touches[0].clientY), { passive: true });
  sheet.addEventListener('touchend', up);
  sheet.addEventListener('touchcancel', up);
  sheet.addEventListener('mousedown', (e) => down(e.clientY));
  window.addEventListener('mousemove', (e) => move(e.clientY));
  window.addEventListener('mouseup', up);
  // スワイプした時はボタンを押したことにしない
  sheet.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  $('sheet-handle').addEventListener('click', () => setSheetCollapsed(!cfg.sheetCollapsed));
  sheet.querySelector('.sheet-row1').addEventListener('click', () => { if (cfg.sheetCollapsed) setSheetCollapsed(false); });
  setSheetCollapsed(cfg.sheetCollapsed);
})();

$('btn-start').onclick = () => start(false);
$('btn-sim').onclick = () => start(true);
$('btn-settings').onclick = openSettings;
$('btn-settings2').onclick = openSettings;
$('btn-stop').onclick = stop;
$('btn-ride').onclick = toggleRide;
$('btn-heat').onclick = () => {
  if (!map.getLayer('heat')) return;
  const on = map.getLayoutProperty('heat', 'visibility') !== 'visible';
  map.setLayoutProperty('heat', 'visibility', on ? 'visible' : 'none');
  $('btn-heat').classList.toggle('on', on);
};
$('recenter').onclick = () => { setFollow(true); render(); };

syncDemand();
demand.update(demandTime(), 1);
renderStart();
refreshVenueEvents(true).then(() => { syncDemand(); demand.update(demandTime(), 1); refreshHeat(); renderStart(); });
if (mapError) $('spot-info').textContent = `地図を表示できません（${mapError}）。案内と音声は使えます`;

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// デバッグ用
window.__navi = { nav, demand, cfg };
