// `cap add android` で作った android/ を、このアプリ用に直す（GitHub Actions で毎回実行）
//   ・位置情報の権限と、読み上げエンジンの呼び出しを追加
//   ・WebView ではできないことを補うプラグイン NaviDevice を追加
//       speak（日本語の音声案内）／keepAwake（画面を点けたまま）／saveDownload（「ダウンロード/巡回ナビ」に保存）
//   ・端末の文字サイズ設定で文字だけが拡大されないようにする（textZoom 100%）
//   ・アイコンと起動画面を巡回ナビのものにする（ImageMagick を使う。7 は magick、6 は convert/identify）
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android/app/src/main/res');
const icon = join(root, '../junkai-navi/icons/icon-512.png');
const BG = '#116a3f'; // アイコンの地の緑（アダプティブアイコンの背景にする）
const has = (cmd) => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
const IM7 = has('magick');
if (!IM7 && !has('convert')) throw new Error('ImageMagick が見つかりません');
const convert = (args) => execFileSync(IM7 ? 'magick' : 'convert', args);
const identify = (args) => execFileSync(IM7 ? 'magick' : 'identify', IM7 ? ['identify', ...args] : args);

// 権限と、Android 11 以降で読み上げエンジンを見つけるための宣言
const manifest = join(root, 'android/app/src/main/AndroidManifest.xml');
let m = readFileSync(manifest, 'utf8');
for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
  if (!m.includes(`android.permission.${p}"`)) m = m.replace('<uses-permission android:name="android.permission.INTERNET" />',
    `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.${p}" />`);
}
if (!m.includes('android.intent.action.TTS_SERVICE')) m = m.replace('<application', `<queries>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
    </queries>

    <application`);
writeFileSync(manifest, m);

// アイコン：アイコンは地が緑一色なので、アダプティブアイコンは背景を同じ緑、前景は中央を縮めたもの（切り抜きの安全範囲に収める）
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(sizes)) {
  const dir = join(res, `mipmap-${d}`);
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) convert([icon, '-resize', `${px}x${px}`, join(dir, name)]); // Android 7 以前
  const fg = Math.round(px * 108 / 48); // 前景は 108dp
  const inner = Math.round(fg * 0.72);
  convert(['-size', `${fg}x${fg}`, `xc:${BG}`, '(', icon, '-resize', `${inner}x${inner}`, ')', '-gravity', 'center', '-composite', join(dir, 'ic_launcher_foreground.png')]);
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
const anydpi = join(res, 'mipmap-anydpi-v26');
mkdirSync(anydpi, { recursive: true });
writeFileSync(join(anydpi, 'ic_launcher.xml'), adaptive);
writeFileSync(join(anydpi, 'ic_launcher_round.xml'), adaptive);
mkdirSync(join(res, 'values'), { recursive: true });
writeFileSync(join(res, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG}</color>
</resources>
`);
// 起動画面：緑の地にアイコンを中央に置く
for (const dir of readdirSync(res).filter((n) => n.startsWith('drawable'))) {
  const out = join(res, dir, 'splash.png');
  if (!existsSync(out)) continue;
  const [w, h] = identify(['-format', '%w %h', out]).toString().trim().split(' ').map(Number);
  const s = Math.round(Math.min(w, h) * 0.32);
  convert(['-size', `${w}x${h}`, `xc:${BG}`, '(', icon, '-resize', `${s}x${s}`, ')', '-gravity', 'center', '-composite', out]);
}

// WebView では使えない音声案内・画面点灯維持・ファイル保存を Android 本体で行うプラグイン。
// 画面からは Capacitor.nativePromise('NaviDevice', 'speak', {text}) などで呼ぶ
const pkgDir = join(root, 'android/app/src/main/java/io/github/syuuhub/junkainavi');
writeFileSync(join(pkgDir, 'NaviDevicePlugin.java'), `package io.github.syuuhub.junkainavi;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

@CapacitorPlugin(name = "NaviDevice")
public class NaviDevicePlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ttsReady = false;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.JAPAN);
                tts.setSpeechRate(1.05f);
                ttsReady = true;
            }
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (tts == null || !ttsReady) { call.reject("tts not ready"); return; }
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "junkai");
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // 端末の「ダウンロード/巡回ナビ」に直接保存（Android 10 以降。権限は不要）
    @PluginMethod
    public void saveDownload(PluginCall call) {
        String name = call.getString("name"), data = call.getString("data"), mime = call.getString("mime", "text/csv");
        if (name == null || data == null) { call.reject("name/data required"); return; }
        if (Build.VERSION.SDK_INT < 29) { call.reject("unsupported"); return; }
        try {
            String dir = Environment.DIRECTORY_DOWNLOADS + "/巡回ナビ";
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
            ContentResolver cr = getContext().getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) { call.reject("insert failed"); return; }
            try (OutputStream os = cr.openOutputStream(uri)) { os.write(data.getBytes(StandardCharsets.UTF_8)); }
            JSObject r = new JSObject();
            r.put("uri", uri.toString());
            r.put("path", dir + "/" + name);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
`);
writeFileSync(join(pkgDir, 'MainActivity.java'), `package io.github.syuuhub.junkainavi;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NaviDevicePlugin.class);
        super.onCreate(savedInstanceState);
        // 端末の文字サイズ設定で文字だけが大きくなり、ナビ画面が崩れるのを防ぐ
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().getSettings().setTextZoom(100);
    }
}
`);
console.log('patched android project');
