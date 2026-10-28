// タクシーアナライザー Service Worker
// 画面（HTML）と場所データ（places.json）はネット優先：つながる時は常に最新を取得してキャッシュを更新、圏外ではキャッシュで起動
// アイコン等の静的ファイルはキャッシュ優先。外部サイト（住所検索・地図）は扱わない
const CACHE = 'taxi-analyzer-v2';
const ASSETS = ['./', './index.html', './places.json', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => (k.startsWith('taxiboard-') || k.startsWith('taxi-analyzer-')) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // 場所データ：つながる時は最新、圏外では最後に読んだ内容
  if (url.pathname.endsWith('/places.json')) {
    e.respondWith(fetch(req, { cache: 'no-cache' })
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./places.json', copy)); } return res; })
      .catch(() => caches.match('./places.json')));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
