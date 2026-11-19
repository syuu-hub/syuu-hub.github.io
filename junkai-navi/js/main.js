import { EndlessNavigator } from './navcore.js?v=5';
import { ValhallaClient } from './valhalla.js?v=5';
import { DemandEngine, CAT_JA } from './demand.js?v=5';
import { fetchSpots, fetchWeather, fetchRailDisruption } from './sources.js?v=5';
import { sliceRoute, pointAt, haversine } from './geo.js?v=5';

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
    spots: [],
    spotsCenter: null,
    events: [],
    pickups: [],
    lastCenter: null,
  },
  load()
);
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch { /* 容量超過など */ } }

// ===== 需要エンジン =====
const demand = new DemandEngine();
function syncDemand() {
  demand.spots = cfg.spots.concat(cfg.events.filter((e) => e.kind === 'custom').map((e) => ({ ...e, cat: 'custom' })));
  demand.events = cfg.events.filter((e) => e.kind !== 'custom' && new Date(e.end).getTime() > Date.now() - 2 * 3600e3);
  demand.pickups = cfg.pickups;
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
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'score'], 0, 0, 3, 1],
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 11, 25, 16, 160],
      'heatmap-opacity': 0.55,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, '#fde68a', 0.5, '#fb923c', 0.8, '#ef4444', 1, '#b91c1c'],
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
const targetEl = document.createElement('div');
targetEl.className = 'target-dot';
const targetMarker = new ML.Marker({ element: targetEl });

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
    else if (type === 'route') {
      if (data.mode === 'switch') toast(`需要の変化に合わせて、${demand.areaName(data.target)}へ向かいます`);
      if (data.mode === 'initial') speak(`巡回を開始します。${demand.areaName(data.target)}へ向かいます`);
      drawRoute();
    }
  },
});
function settingsForNav() {
  return { commitSec: +cfg.commitSec, replanMs: cfg.replanMin * 60e3, switchGain: +cfg.switchGain, radiusM: cfg.radiusKm * 1000 };
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
  ['banner', 'sheet', 'speed'].forEach((id) => $(id).classList.remove('hidden'));
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
  ensureSpots(center).then(() => { syncDemand(); demand.update(new Date(), 1); return refreshDemand(); });
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
  puck.remove(); targetMarker.remove();
  ['banner', 'sheet', 'speed', 'recenter'].forEach((id) => $(id).classList.add('hidden'));
  $('start').classList.remove('hidden');
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0 } });
  save();
  renderStart();
}

// 実車・空車の切り替え
function toggleRide() {
  if (!running) return;
  if (!riding) {
    riding = true;
    if (lastFix) { cfg.pickups.push({ lng: lastFix.point[0], lat: lastFix.point[1], t: Date.now() }); save(); }
    if (nav.target) demand.markVisited(nav.target.key);
    nav.route = null; nav.target = null;
    drawRoute();
    speak('実車です。乗車地点を記録しました');
  } else {
    riding = false;
    nav.reset();
    nav.s = { ...nav.s, ...settingsForNav() };
    nav.serviceCenter = lastFix ? lastFix.point : null;
    speak('空車に戻りました。巡回を再開します');
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
  if (!nav.route) { src.setData(empty); targetMarker.remove(); return; }
  const coords = sliceRoute(nav.route, nav.along);
  src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  if (nav.target) targetMarker.setLngLat(nav.target.center).addTo(map);
}

function render() {
  if (!running) return;
  const fix = lastFix;
  if (fix) {
    puck.setLngLat(fix.point).addTo(map);
    const hd = nav.heading ?? 0;
    puck.setRotation(hd);
    $('speed-v').textContent = Math.round((nav.speed || 0) * 3.6);
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
    $('b-dist').textContent = '実車中';
    $('b-street').textContent = '降車後に「空車」を押すと巡回を再開します';
    $('b-then').classList.add('hidden');
    $('s-mode').textContent = '実車中'; $('s-mode').classList.add('riding');
    $('s-target').textContent = '';
    $('s-meta').textContent = `本日の乗車記録 ${todayPickups()} 件`;
    $('s-level').textContent = '';
    $('btn-ride-label').textContent = '空車';
    $('btn-ride').classList.add('riding');
    return;
  }
  $('s-mode').textContent = '巡回中'; $('s-mode').classList.remove('riding');
  $('btn-ride-label').textContent = '実車';
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
  $('s-target').textContent = demand.areaName(v.target);
  $('s-meta').textContent = `${fmtDist(v.remaining)} ・ 約${Math.max(1, Math.round(v.eta / 60))}分 ・ ${weatherJa()}`;
  const lv = demand.level(v.target && demand.areas.get(v.target.key));
  $('s-level').textContent = '需要 ' + '●'.repeat(lv) + '○'.repeat(5 - lv);
}
const weatherJa = () => ({ clear: '晴れ', rain: '雨', heavy: '大雨' }[demand.weather] || '') + (demand.railDisruption ? '・鉄道遅延' : '');
function todayPickups() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return cfg.pickups.filter((p) => p.t >= d.getTime()).length;
}

function renderStart() {
  const n = cfg.spots.length;
  const cats = {};
  for (const s of cfg.spots) cats[s.cat] = (cats[s.cat] || 0) + 1;
  const detail = Object.entries(cats).map(([k, c]) => `${CAT_JA[k]} ${c}`).join('・');
  $('spot-info').innerHTML = n
    ? `需要スポット ${n} 件（${detail}）<br>乗車記録 ${cfg.pickups.length} 件`
    : '開始すると現在地の周辺から駅・ホテル・病院・繁華街などを自動で取得します';
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
  toast(kind === 'event' ? `「${name}」を追加しました（終了前後に需要が上がります）` : `「${name}」を需要地点に追加しました`);
  syncDemand(); demand.update(new Date()); refreshHeat(); renderEvents();
};

// ===== 設定画面 =====
function openSettings() {
  $('set-spots').textContent = `取得済み ${cfg.spots.length} 件`;
  $('set-radius').value = cfg.radiusKm;
  $('set-weather').value = cfg.weatherMode;
  $('set-rail').checked = cfg.railManual;
  $('set-odpt').value = cfg.odptKey;
  $('set-voice').checked = cfg.voice;
  $('set-commit').value = cfg.commitSec;
  $('set-replan').value = cfg.replanMin;
  $('set-gain').value = cfg.switchGain;
  $('set-router').value = cfg.routerUrl;
  $('set-sim').value = cfg.simSpeed;
  $('set-pickups').textContent = `記録 ${cfg.pickups.length} 件（需要の学習に使います）`;
  renderEvents();
  $('settings').classList.remove('hidden');
}
function renderEvents() {
  const box = $('event-list');
  box.innerHTML = '';
  for (const ev of cfg.events) {
    const row = document.createElement('div');
    row.className = 'ev';
    const when = ev.kind === 'event' ? ` ・ 終了 ${new Date(ev.end).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ' ・ 常設';
    row.innerHTML = `<span></span><button>削除</button>`;
    row.firstChild.textContent = ev.name + when;
    row.lastChild.onclick = () => { cfg.events = cfg.events.filter((x) => x !== ev); save(); syncDemand(); renderEvents(); };
    box.appendChild(row);
  }
}
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
bind('set-router', 'routerUrl', (v) => v.trim() || 'https://valhalla1.openstreetmap.de');
bind('set-sim', 'simSpeed', Number);

$('btn-fetch').onclick = async () => {
  const c = lastFix ? lastFix.point : await firstPosition();
  cfg.spotsCenter = null;
  await ensureSpots(c);
  $('set-spots').textContent = `取得済み ${cfg.spots.length} 件`;
  syncDemand(); demand.update(new Date(), 1); refreshHeat(); renderStart();
};
$('btn-clear-spots').onclick = () => { cfg.spots = []; cfg.spotsCenter = null; save(); $('set-spots').textContent = '取得済み 0 件'; renderStart(); };
$('btn-export').onclick = async () => {
  const text = JSON.stringify({ pickups: cfg.pickups, events: cfg.events });
  $('io').classList.remove('hidden');
  $('io').value = text;
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { $('io').select(); toast('表示されたテキストをコピーしてください'); }
};
$('btn-import').onclick = () => {
  const box = $('io');
  if (box.classList.contains('hidden') || !box.value.trim()) { box.classList.remove('hidden'); box.value = ''; box.focus(); toast('JSONを貼り付けて、もう一度「読み込み」を押してください'); return; }
  try {
    const j = JSON.parse(box.value);
    if (Array.isArray(j.pickups)) cfg.pickups = cfg.pickups.concat(j.pickups);
    if (Array.isArray(j.events)) cfg.events = cfg.events.concat(j.events);
    save(); syncDemand(); openSettings(); toast('読み込みました');
  } catch { toast('JSONの形式が正しくありません'); }
};
let clearArmed = 0;
$('btn-clear-pickups').onclick = () => {
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); toast('もう一度押すと乗車記録をすべて消去します'); return; }
  cfg.pickups = []; save(); openSettings(); toast('乗車記録を消去しました');
};

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
