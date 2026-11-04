// タクシー勤怠管理 Service Worker（サイト直下）
// 画面（HTML）はネット優先：つながる時は常に最新を取得してキャッシュを更新、圏外ではキャッシュで起動
// アイコン等はキャッシュ優先。Tailwind・フォントのCDNは一度読んだものを保存して圏外でも表示できるようにする
// サブフォルダの各アプリ（taxi-analyzer など）のファイルには手を出さない
const CACHE = 'taxishift-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/icon.svg'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const ROOT = new URL('./', self.location).pathname; // 例: "/"
const OWN_PATHS = new Set(ASSETS.map(a => new URL(a, self.location).pathname));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('taxishift-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;

  // CDN（Tailwind・Googleフォント）：キャッシュがあれば即表示し、裏で更新
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }

  if (url.origin !== location.origin) return;
  // このアプリ自身のファイル以外（サブフォルダのアプリ等）は素通し
  if (!OWN_PATHS.has(url.pathname)) return;

  if (req.mode === 'navigate' || url.pathname === ROOT || url.pathname.endsWith('/index.html')) {
    e.respondWith(fetch(req)
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); } return res; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
