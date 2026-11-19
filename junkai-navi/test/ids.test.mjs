// node test/ids.test.mjs — main.js が使う画面の部品（id）が index.html にすべてあるか、?v= の番号がそろっているか
import { readFileSync, readdirSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
let fails = 0;
const ids = [...new Set([...main.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
for (const id of ids) if (!html.includes(`id="${id}"`)) { fails++; console.error('NG: index.html に id がない:', id); }
console.log(`OK: id ${ids.length - fails}/${ids.length}`);
const files = ['../index.html', '../sw.js', '../diag.html', ...readdirSync(new URL('../js/', import.meta.url)).map((f) => '../js/' + f)];
const vers = new Set(files.flatMap((f) => [...readFileSync(new URL(f, import.meta.url), 'utf8').matchAll(/\?v=(\d+)/g)].map((m) => m[1])));
if (vers.size !== 1) { fails++; console.error('NG: ?v= の番号がそろっていない:', [...vers]); } else console.log(`OK: ?v=${[...vers][0]} でそろっている`);
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
if (!sw.includes(`endless-navi-v${[...vers][0]}'`)) { fails++; console.error('NG: sw.js のキャッシュ名が ?v= と違う'); } else console.log('OK: sw.js のキャッシュ名');
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
