// `cap add android` で作った android/ を、このアプリ用に直す（GitHub Actions で毎回実行）
//   ・位置情報の権限を追加（アプリ内の navigator.geolocation 用）
//   ・Android 本体の住所変換（番地まで）を呼べるプラグイン JpGeocoder を追加
//   ・端末の文字サイズ設定で文字だけが拡大されないようにする（textZoom 100%）
//   ・アイコンと起動画面をタクシーアナライザーのものにする（ImageMagick を使う。7 は magick、6 は convert/identify）
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android/app/src/main/res');
const icon = join(root, '../taxi-analyzer/icons/icon-512.png');
const has = cmd => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
const IM7 = has('magick');
if (!IM7 && !has('convert')) throw new Error('ImageMagick が見つかりません');
const convert = args => execFileSync(IM7 ? 'magick' : 'convert', args);
const identify = args => execFileSync(IM7 ? 'magick' : 'identify', IM7 ? ['identify', ...args] : args);

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
    if (existsSync(out)) convert([icon, '-resize', `${px}x${px}`, out]);
  }
}
// 起動画面：アプリの背景色にアイコンを中央に置く
for (const dir of readdirSync(res).filter(n => n.startsWith('drawable'))) {
  const out = join(res, dir, 'splash.png');
  if (!existsSync(out)) continue;
  const [w, h] = identify(['-format', '%w %h', out]).toString().trim().split(' ').map(Number);
  const s = Math.round(Math.min(w, h) * 0.28);
  convert(['-size', `${w}x${h}`, 'xc:#0A0C0F', '(', icon, '-resize', `${s}x${s}`, ')', '-gravity', 'center', '-composite', out]);
}
// Android 本体の住所変換（Geocoder）：緯度経度 → 番地までの住所（reverse）、住所 → 番地の位置（forward）。
// アプリ内の画面から Capacitor.nativePromise('JpGeocoder', 'reverse', {lat, lng}) / ('JpGeocoder', 'forward', {addr}) で呼ぶ
const pkgDir = join(root, 'android/app/src/main/java/io/github/syuuhub/taxianalyzer');
writeFileSync(join(pkgDir, 'JpGeocoderPlugin.java'), `package io.github.syuuhub.taxianalyzer;

import android.location.Address;
import android.location.Geocoder;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "JpGeocoder")
public class JpGeocoderPlugin extends Plugin {
    @PluginMethod
    public void reverse(PluginCall call) {
        Double lat = call.getDouble("lat"), lng = call.getDouble("lng");
        if (lat == null || lng == null) { call.reject("lat/lng required"); return; }
        if (!Geocoder.isPresent()) { call.reject("geocoder unavailable"); return; }
        new Thread(() -> {
            try {
                List<Address> list = new Geocoder(getContext(), Locale.JAPAN).getFromLocation(lat, lng, 1);
                JSObject r = new JSObject();
                if (list != null && !list.isEmpty()) {
                    Address a = list.get(0);
                    r.put("line", a.getMaxAddressLineIndex() >= 0 ? a.getAddressLine(0) : "");
                    r.put("admin", a.getAdminArea());
                    r.put("locality", a.getLocality());
                    r.put("subLocality", a.getSubLocality());
                    r.put("thoroughfare", a.getThoroughfare());
                    r.put("subThoroughfare", a.getSubThoroughfare());
                }
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void forward(PluginCall call) {
        String addr = call.getString("addr");
        if (addr == null || addr.isEmpty()) { call.reject("addr required"); return; }
        if (!Geocoder.isPresent()) { call.reject("geocoder unavailable"); return; }
        new Thread(() -> {
            try {
                List<Address> list = new Geocoder(getContext(), Locale.JAPAN).getFromLocationName(addr, 1);
                JSObject r = new JSObject();
                if (list != null && !list.isEmpty() && list.get(0).hasLatitude()) {
                    Address a = list.get(0);
                    r.put("lat", a.getLatitude());
                    r.put("lng", a.getLongitude());
                    r.put("line", a.getMaxAddressLineIndex() >= 0 ? a.getAddressLine(0) : "");
                }
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }
}
`);
writeFileSync(join(pkgDir, 'MainActivity.java'), `package io.github.syuuhub.taxianalyzer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JpGeocoderPlugin.class);
        super.onCreate(savedInstanceState);
        // 端末の文字サイズ設定で文字だけが大きくなり、ボタンの余白が無くなるのを防ぐ（ブラウザと同じ見た目にする）
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().getSettings().setTextZoom(100);
    }
}
`);
console.log('patched android project');
