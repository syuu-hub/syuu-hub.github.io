// `cap add android` で作った android/ を、このアプリ用に直す（GitHub Actions で毎回実行）
//   ・位置情報（速度・ルート）と振動の権限、読み上げエンジンの呼び出しを追加
//   ・WebView ではできないことを補うプラグイン GDevice を追加
//       speak（日本語の読み上げ）／vibrate（振動）／keepAwake（画面を点けたまま）
//   ・端末の文字サイズ設定で文字だけが拡大されないようにする（textZoom 100%）
//   ・アイコンと起動画面を Gメーターのものにする（ImageMagick を使う。7 は magick、6 は convert/identify）
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android/app/src/main/res');
const icon = join(root, '../g-meter/icons/icon-512.png');
const iconFg = join(root, '../g-meter/icons/icon-maskable-512.png');   // 周りに余白のある版（アダプティブアイコンの前景用）
const BG = '#0E1014';
const has = cmd => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
const IM7 = has('magick');
if (!IM7 && !has('convert')) throw new Error('ImageMagick が見つかりません');
const convert = args => execFileSync(IM7 ? 'magick' : 'convert', args);
const identify = args => execFileSync(IM7 ? 'magick' : 'identify', IM7 ? ['identify', ...args] : args);

// 権限と、Android 11 以降で読み上げエンジンを見つけるための宣言
const manifest = join(root, 'android/app/src/main/AndroidManifest.xml');
let m = readFileSync(manifest, 'utf8');
for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'VIBRATE']) {
  if (!m.includes(`android.permission.${p}"`)) m = m.replace('<uses-permission android:name="android.permission.INTERNET" />',
    `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.${p}" />`);
}
if (!m.includes('android.intent.action.TTS_SERVICE')) m = m.replace('<application', `<queries>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
    </queries>

    <application`);
writeFileSync(manifest, m);

// アイコン（Android 8 以降はアダプティブアイコン：背景色＋前景）
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(sizes)) {
  const dir = join(res, `mipmap-${d}`);
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) convert([icon, '-resize', `${px}x${px}`, join(dir, name)]);   // Android 7 以前
  const fg = Math.round(px * 108 / 48);   // 前景は 108dp
  convert([iconFg, '-resize', `${fg}x${fg}`, join(dir, 'ic_launcher_foreground.png')]);
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
// 起動画面：アプリの背景色にアイコンを中央に置く
for (const dir of readdirSync(res).filter(n => n.startsWith('drawable'))) {
  const out = join(res, dir, 'splash.png');
  if (!existsSync(out)) continue;
  const [w, h] = identify(['-format', '%w %h', out]).toString().trim().split(' ').map(Number);
  const s = Math.round(Math.min(w, h) * 0.28);
  convert(['-size', `${w}x${h}`, `xc:${BG}`, '(', icon, '-resize', `${s}x${s}`, ')', '-gravity', 'center', '-composite', out]);
}

// WebView では使えない読み上げ・振動・画面点灯維持を Android 本体で行うプラグイン。
// 画面からは Capacitor.nativePromise('GDevice', 'speak', {text}) などで呼ぶ
const pkgDir = join(root, 'android/app/src/main/java/io/github/syuuhub/gmeter');
writeFileSync(join(pkgDir, 'GDevicePlugin.java'), `package io.github.syuuhub.gmeter;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

@CapacitorPlugin(name = "GDevice")
public class GDevicePlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ttsReady = false;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.JAPAN);
                tts.setSpeechRate(1.15f);
                ttsReady = true;
            }
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (tts == null || !ttsReady) { call.reject("tts not ready"); return; }
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "gmeter");
        call.resolve();
    }

    @PluginMethod
    public void vibrate(PluginCall call) {
        int ms = call.getInt("ms", 120);
        Vibrator v;
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            v = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            v = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (v != null) {
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            else v.vibrate(ms);
        }
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

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
`);
writeFileSync(join(pkgDir, 'MainActivity.java'), `package io.github.syuuhub.gmeter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GDevicePlugin.class);
        super.onCreate(savedInstanceState);
        // 端末の文字サイズ設定で文字だけが大きくなり、1画面に収めた走行画面が崩れるのを防ぐ
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().getSettings().setTextZoom(100);
    }
}
`);
console.log('patched android project');
