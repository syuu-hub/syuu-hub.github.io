// 一時的：GLION ARENA KOBE のイベントページをブラウザで表示して中身を確認（確認が済んだら消す）
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('events-probe/out', { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ locale: 'ja-JP' });
const apis = [];
p.on('response', async r => { const u = r.url(); if (/appsync|graphql|api/i.test(u)) { let body = ''; try { body = (await r.text()).slice(0, 20000); } catch (e) {} apis.push({ u, s: r.status(), req: r.request().postData()?.slice(0, 3000), body }); } });
await p.goto('https://www.totteikobe.jp/event', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForTimeout(4000);
writeFileSync('events-probe/out/glion-render.html', await p.content());
writeFileSync('events-probe/out/glion-text.txt', await p.evaluate(() => document.body.innerText));
// 月の切り替え（次の月）を試す
const btns = await p.$$eval('button, a', els => els.map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 200));
writeFileSync('events-probe/out/glion-buttons.txt', btns.join('\n'));
writeFileSync('events-probe/out/glion-api.json', JSON.stringify(apis, null, 1));
await b.close();
console.log('ok', apis.length);
