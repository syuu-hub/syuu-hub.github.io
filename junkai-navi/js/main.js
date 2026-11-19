import { EndlessNavigator } from './navcore.js?v=12';
import { ValhallaClient } from './valhalla.js?v=12';
import { DemandEngine, CAT_JA } from './demand.js?v=12';
import { fetchSpots, fetchWeather, fetchRailDisruption } from './sources.js?v=12';
import { sliceRoute, pointAt, haversine } from './geo.js?v=12';
import { decodeCsv, importAnalyzerCsv, placeKey, rideType, rideFilter, kindsLabel, DEFAULT_KINDS } from './csv.js?v=12';
import { geocode, geocodeAny, queryCandidates, centerOf, placesToCsv, csvToPlaces, mergePlaces, fmtStamp } from './places.js?v=12';

const $ = (id) => document.getElementById(id);
const STORE = 'endless-navi-v1';
const DEFAULT_CENTER = [139.7671, 35.6812]; // 東京駅

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
function syncDemand() {
  const manual = cfg.demandSource !== 'csv';
  demand.spots = manual ? cfg.spots.concat(cfg.events.filter((e) => e.kind === 'custom').map((e) => ({ ...e, cat: 'custom' }))) : [];
  demand.csvRides = manual ? [] : cfg.csvRides.filter(rideFilter(cfg.csvKinds));
  demand.events = cfg.events.filter((e) => e.kind !== 'custom' && new Date(e.end).getTime() > Date.now() - 2 * 3600e3);
  demand.railDisruption = cfg.railManual || odptDisruption;
  if (cfg.weatherMode !== 'auto') demand.weather = cfg.weatherMode;
}
let odptDisruption = false;

// ===== 音声 =====
let jaVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  jaVoice = vs.find((v) => v.lang === 'ja-JP' && /Kyoko|O-Ren|Google/.test(v.name)) || vs.find((v) => v.lang && v.lang.startsWith('ja')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, force = false) {
  if ((!cfg.voice && !force) || !('speechSynthesis' in window)) return;
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
    getLayer: (id) => layers[id],
    getCanvasContainer: () => el,
    easeTo() {},
    getCenter: () => ({ toArray: () => center }),
    unproject: () => ({ lng: center[0], lat: center[1] }),
  };
}
const NullMarker = class { constructor() {} setLngLat() { return this; } addTo() { return this; } setRotation() { return this; } remove() {} };
let map, ML = window.maplibregl, mapError = null;
try {
  if (!ML) throw new Error('地図ライブラリを読み込めませんでした');
  map = new ML.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: cfg.lastCenter || DEFAULT_CENTER,
    zoom: 14,
    attributionControl: false,
    pitchWithRotate: true,
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
  map.addSource('route', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b57d0', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 7, 18, 22] } }, firstSymbol);
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#4c8df6', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4.5, 18, 16] } }, firstSymbol);
  refreshHeat();
});
map.on('dragstart', () => { if (running) setFollow(false); });

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
  router: { route: (...a) => router.route(...a) },
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
  return { commitSec: +cfg.commitSec, replanMs: cfg.replanMin * 60e3, switchGain: +cfg.switchGain, radiusM: cfg.radiusKm * 1000, tourMax: Math.min(4, Math.max(1, +cfg.tourMax || 3)), revisitMin: Math.min(180, Math.max(15, +cfg.revisitMin || 60)) };
}

let running = false, riding = false, simulate = false, follow = true;
let watchId = null, simTimer = null, loopTimer = null, demandTimer = null, wakeLock = null;
let lastFix = null, simPos = null;

function onFix(fix) {
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
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* noop */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') requestWakeLock(); });

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
  syncDemand();
  demand.update(new Date());
  refreshHeat();
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
  demand.update(new Date(), 1);
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
    ensureSpots(center).then(() => { syncDemand(); demand.update(new Date(), 1); return refreshDemand(); });
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
  if (!nav.route) { src.setData(empty); drawTourMarkers([]); drawRoute.sig = null; return; }
  const coords = sliceRoute(nav.route, nav.along);
  src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  const upcoming = nav.tourRemaining();
  const sig = upcoming.map((a) => a.key).join('|');
  if (sig !== drawRoute.sig) { drawRoute.sig = sig; drawTourMarkers(upcoming); }
}

function render() {
  if (!running) return;
  const fix = lastFix;
  if (fix) {
    puck.setLngLat(fix.point).addTo(map);
    const hd = nav.heading ?? 0;
    puck.setRotation(hd);
    if (follow) {
      const kmh = (nav.speed || 0) * 3.6;
      const zoom = kmh > 50 ? 15.6 : kmh > 25 ? 16.3 : 17;
      map.easeTo({
        center: fix.point, bearing: hd, pitch: 55, zoom,
        padding: { top: window.innerHeight * 0.38, bottom: 170 },
        duration: 950, easing: (t) => t,
      });
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

function renderStart() {
  if (cfg.demandSource === 'csv') {
    const n = cfg.csvRides.filter(rideFilter(cfg.csvKinds)).length;
    $('spot-info').innerHTML = cfg.csvRides.length
      ? `需要エリア：タクシーアナライザのCSV<br>乗車実績 ${n} 件（${kindsLabel(cfg.csvKinds)}）`
      : '需要エリア：タクシーアナライザのCSV<br>設定からCSVを読み込んでください';
    return;
  }
  const n = cfg.spots.length;
  const cats = {};
  for (const s of cfg.spots) cats[s.cat] = (cats[s.cat] || 0) + 1;
  const detail = Object.entries(cats).map(([k, c]) => `${CAT_JA[k]} ${c}`).join('・');
  const custom = cfg.events.filter((e) => e.kind === 'custom').length;
  $('spot-info').innerHTML = n || custom
    ? `需要エリア：任意で設定<br>需要スポット ${n} 件${detail ? `（${detail}）` : ''}${custom ? `・登録地点 ${custom} 件` : ''}`
    : '需要エリア：任意で設定<br>開始すると現在地の周辺から駅・ホテル・病院・繁華街などを自動で取得します';
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
  syncDemand(); demand.update(new Date()); refreshHeat(); renderEvents();
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
  save(); syncDemand(); demand.update(new Date()); refreshHeat(); renderStart(); renderEvents(); renderPlaces();
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
    box.innerHTML = '<div class="pl-empty">まだ登録がありません。「＋ 住所から追加」かCSVの読み込みで登録できます。</div>';
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
    item.innerHTML = `<div class="pl-top"><span class="pl-name"></span>${badge}</div><div class="pl-addr"></div>
      <div class="pl-btns">${running ? '<button data-a="map">地図</button>' : ''}<button data-a="edit">編集</button><button data-a="del" class="del">削除</button></div>`;
    item.querySelector('.pl-name').textContent = ev.name;
    item.querySelector('.pl-addr').textContent = ev.addr || '地図の長押しで追加（住所なし）';
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
  $('pl-end').value = toLocalInput(ev && ev.end ? ev.end : Date.now() + 3 * 3600e3);
  $('pl-size').value = ev && ev.size ? ev.size : 'm';
  $('pl-found').classList.add('hidden');
  $('pl-form').classList.remove('hidden');
  $('pl-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  (ev ? $('pl-name') : $('pl-addr')).focus();
}
function closePlaceForm() { plEditId = null; plFound = null; $('pl-form').classList.add('hidden'); }
document.querySelectorAll('input[name=pl-kind]').forEach((r) => r.addEventListener('change', () => $('pl-event').classList.toggle('hidden', plKind() !== 'event')));
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([placesToCsv(cfg.events)], { type: 'text/csv;charset=utf-8' }));
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
  save(); syncDemand(); demand.areas = new Map(); demand.update(new Date(), 1); refreshHeat(); renderStart();
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
  syncDemand(); demand.update(new Date(), 1); refreshHeat(); renderStart();
};
$('btn-clear-spots').onclick = () => { cfg.spots = []; cfg.spotsCenter = null; save(); $('set-spots').textContent = '取得済み 0 件'; renderStart(); };
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => $(b.dataset.close).classList.add('hidden')));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

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
demand.update(new Date(), 1);
renderStart();
if (mapError) $('spot-info').textContent = `地図を表示できません（${mapError}）。案内と音声は使えます`;

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// デバッグ用
window.__navi = { nav, demand, cfg };
