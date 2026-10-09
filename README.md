# キャラクター体型シミュレーター

創作でキャラクターの身長・体重を決めるときに、数字だけでなく体型のイメージを3Dで確認するためのWebツールです。
二人分の設定を並べて、身長差・体格差を比べられます。

- 性別・身長・筋肉量・体脂肪率から、体重・BMIなどを算出
- 体重を指定して、筋肉量・体脂肪率を逆算（範囲外なら筋肉量も自動調整）
- 二人を同じ縮尺で並べて3D表示、目線の高さの比較、回転・拡大・移動
- パターン（キャラクター名と数値）の保存・呼び出し、戻る・進む、共有URL、画像保存

## 使い方

3Dモデルを読み込むため、ファイルを直接開かず、簡易サーバーで開きます。

```
python -m http.server 8000
```

ブラウザで `http://localhost:8000/` を開いてください。

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` | 画面 |
| `app.js` | 画面と3Dの制御（入力・描画・履歴・保存） |
| `body.js` | 体重・BMIなどの計算（画面に依存しない。`tools/calc_check.html` で確認できる） |
| `figure.js` | 3D人体の変形（筋肉・体重・胸の大きさ、まっすぐ立つ姿勢への補正） |
| `models/` | 変換済みの3Dデータ |
| `tools/convert_makehuman.py` | MakeHuman のデータから `models/` を作るスクリプト |
| `vendor/` | Three.js（MIT） |
| `docs/要件定義書.md` | 要件定義（作成時点のもの。実装で変更・追加した点は反映していません） |

## 3Dデータについて

人体は [MakeHuman](https://github.com/makehumancommunity/makehuman) の素体メッシュと体型データ（CC0）を、`tools/convert_makehuman.py` で変換して使っています。
作り直すときは、MakeHuman のリポジトリの `makehuman/data` を指定します。

```
python tools/convert_makehuman.py <makehuman/data のパス> models
```

## 注意

表示される数値は創作の参考値であり、医学的な診断ではありません。
