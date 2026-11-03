// `cap add android` で作った android/ を、このアプリ用に直す（GitHub Actions で毎回実行）
//   ・位置情報の権限を追加（アプリ内の navigator.geolocation 用）
//   ・アイコンと起動画面をタクシーアナライザーのものにする（ImageMagick の convert を使う）
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android/app/src/main/res');
const icon = join(root, '../taxi-analyzer/icons/icon-512.png');

// 権限
const manifest = join(root, 'android/app/src/main/AndroidManifest.xml');
let m = readFileSync(manifest, 'utf8');
for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
  if (!m.includes(p)) m = m.replace('<uses-permission android:name="android.permission.INTERNET" />',
    `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.${p}" />`);
}
writeFileSync(manifest, m);

// アイコン：アダプティブアイコンの定義を消し、各解像度の PNG を差し替える
rmSync(join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(sizes)) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    const out = join(res, `mipmap-${d}`, name);
    if (existsSync(out)) execFileSync('convert', [icon, '-resize', `${px}x${px}`, out]);
  }
}
// 起動画面：アプリの背景色にアイコンを中央に置く
for (const dir of readdirSync(res).filter(n => n.startsWith('drawable'))) {
  const out = join(res, dir, 'splash.png');
  if (!existsSync(out)) continue;
  const [w, h] = execFileSync('identify', ['-format', '%w %h', out]).toString().trim().split(' ').map(Number);
  const s = Math.round(Math.min(w, h) * 0.28);
  execFileSync('convert', ['-size', `${w}x${h}`, 'xc:#0A0C0F', '(', icon, '-resize', `${s}x${s}`, ')', '-gravity', 'center', '-composite', out]);
}
console.log('patched android project');
