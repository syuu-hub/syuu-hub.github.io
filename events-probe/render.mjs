// 一時的：GLION ARENA KOBE のイベント（翌月の切り替え・詳細ページ）を確認（確認が済んだら消す）
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('events-probe/out', { recursive: true });
const r = await fetch('https://www.totteikobe.jp/event/article/30480', { headers: { 'User-Agent': 'Mozilla/5.0' } });
writeFileSync('events-probe/out/glion-detail-plain.html', await r.text());
const b = await chromium.launch();
const p = await b.newPage({ locale: 'ja-JP' });
await p.goto('https://www.totteikobe.jp/event/article/30480', { waitUntil: 'networkidle', timeout: 60000 });
writeFileSync('events-probe/out/glion-detail-text.txt', await p.evaluate(() => document.body.innerText));
await p.goto('https://www.totteikobe.jp/event', { waitUntil: 'networkidle', timeout: 60000 });
const tabs = await p.$$eval('*', els => els.filter(e => /^(12|DEC)$/.test((e.innerText || '').trim()) || /12\s*DEC/.test((e.innerText || '').trim())).slice(0, 10).map(e => e.tagName + '.' + e.className + ' | ' + e.outerHTML.slice(0, 200)));
writeFileSync('events-probe/out/glion-tabs.txt', tabs.join('\n'));
const t = p.getByText('DEC', { exact: true }).first();
try { await t.click(); await p.waitForTimeout(4000); } catch (e) { console.log('click fail', e.message); }
writeFileSync('events-probe/out/glion-dec.txt', await p.evaluate(() => document.body.innerText));
await b.close();
console.log('ok');
