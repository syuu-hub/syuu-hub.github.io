// 一時的：ページを取得して保存（中身の確認用。確認が済んだら消す）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('events-probe/out', { recursive: true });
const lines = readFileSync('events-probe/urls.txt', 'utf8').trim().split('\n').map(l => l.split(' '));
const log = [];
for (const [k, u] of lines) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; taxi-analyzer-events/1.0)', 'Accept-Language': 'ja' } });
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(`events-probe/out/${k}.html`, buf);
    log.push(`${k} ${r.status} ${r.url} ${buf.length}`);
  } catch (e) { log.push(`${k} ERR ${u} ${e.message}`); }
}
writeFileSync('events-probe/out/_log.txt', log.join('\n') + '\n');
