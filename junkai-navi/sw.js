// 同じサイトの他アプリのキャッシュには触れない
// アプリ本体のみキャッシュ（地図タイル・ルート・需要データは常に最新を取得）
const CACHE = 'endless-navi-v32';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js?v=32', 'js/navcore.js?v=32', 'js/geo.js?v=32', 'js/valhalla.js?v=32', 'js/demand.js?v=32', 'js/sources.js?v=32', 'js/csv.js?v=32', 'js/places.js?v=32', 'js/profile.js?v=32', 'js/region.js?v=32', 'js/calendar.js?v=32', 'js/model.js?v=32', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('endless-navi-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // ネット優先・失敗時にキャッシュ（更新がすぐ反映されるように）
  // ブラウザのHTTPキャッシュ（GitHub Pages は最大10分）に古い版が残っていても、必ずサーバーに確認する。
  // 画面（HTML）とプログラム（JS）の版がずれると起動時にエラーになるため
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
