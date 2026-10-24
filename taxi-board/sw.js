// 旧URL（/taxi-board/）の Service Worker を片付ける：古いキャッシュを消して自分を登録解除し、開いている画面を新URLへ
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('taxiboard-')) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(new URL('../taxi-analyzer/', self.registration.scope).href);
  })());
});
