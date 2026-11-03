# タクシーアナライザー（Android アプリ）

公開ページ（https://syuu-hub.github.io/taxi-analyzer/）をアプリの中で開く外枠です。
記録はアプリ専用の場所に保存されるので、Chrome の履歴・キャッシュ・サイトデータを消しても消えません。
画面や機能の更新は公開ページに反映すればアプリにも反映されます（APK の入れ直しは不要）。

## インストール
1. スマホで https://github.com/syuu-hub/syuu-hub.github.io/releases/tag/taxi-analyzer-apk を開き、`taxi-analyzer.apk` をダウンロード
2. 「提供元不明のアプリ」のインストールを許可してインストール

## 今のデータを移す（1回だけ）
1. Chrome で開いているタクシーアナライザーで「出力・設定 → バックアップ・データ → JSONで保存」
2. アプリを開き「復元」で 1 のファイルを選ぶ

## 署名の鍵について
APK は、リポジトリの Secrets に登録した鍵で署名します（`ANDROID_KEYSTORE_B64`：鍵を base64 にしたもの、`ANDROID_KEY_PASS`：パスワード）。
同じ鍵で署名している間は、新しい APK を上書きインストールしても記録は消えません。
Secrets が無い時は、その回だけの鍵で署名します（次の APK を入れる時はアンインストールが必要になり、記録が消えるので注意）。
