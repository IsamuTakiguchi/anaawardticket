# ANA特典航空券スイープ検索 (Chrome拡張機能)

ANAマイレージクラブの特典航空券（**国内線・国際線**）の空席を、**期間・出発曜日・帰国オフセット（出発の何日後に帰るか）**を条件にまとめて連続検索（スイープ）し、結果を一覧で整理する Manifest V3 Chrome 拡張機能です。

各組み合わせについて、以下を一覧表示します：

- **ANA運航便 / スターアライアンス提携便** の区別（バッジ表示）
- 発着時刻・便名・乗り継ぎ回数
- 必要マイル
- 燃油サーチャージ（国際線のみ。国内線は対象外）

ソート（マイル / 燃油 / 日付）、フィルタ（ANA・提携・キャビン・最大マイル・燃油なし）、CSV 出力に対応。

> ⚠️ **重要 / 免責**: 本ツールは利用者本人のログイン済み ANA セッション上で動作する個人用補助ツールです。ANA サイトの自動照会は同社の利用規約に抵触する可能性があります。**個人・低頻度・保守的な検索間隔**での利用に留め、再配布・商用スクレイピングには使用しないでください。過度な検索はレート制限・captcha・アカウント制限を招く恐れがあります。利用は自己責任で。資格情報は一切保存・送信しません。

## 実機調査で判明した重要事実（国際線特典の本流は「旧エンジン」）

実際のHARと結果ページHTMLを解析した結果、ANA国際線特典の往復空席照会は
**旧エンジン `aswbe-i.ana.co.jp/.../award_search_roundtrip_result_owd.xhtml`**
（JSF/サーバーレンダリング）で提供されており、**検索結果はJSON通信ではなく
ページのHTMLに埋め込まれている**ことが確定しました。

- 便・空港・時刻・ANA/スターアライアンス区分 … `.itinModeAvailabilityResult` のDOM
- **必要マイル・空席数・税金/燃油** … 埋め込みJSの `addRecommendation(rank, 往路ID,
  復路ID, …, requiredMiles, …, 往路席, 復路席, 税金, …)` 呼び出し
- 往路と復路は radio の `data-value`（内部ID）で突き合わせ

そのため、この旧エンジンに対しては**JSON傍受ではなくHTML(DOM)解析**が正解で、
`src/core/legacy-intl-parser.ts` がこれを実装しています（実データ準拠のテスト
`test/legacy-intl-parser.test.ts` 付き）。サイドパネル「結果」タブの
**「現在のANA結果ページを取り込む」**ボタンで、開いている結果ページを即座に
一覧化できます（単一ページ取り込み）。

> 一方、JSON傍受 (`interceptor.ts` / `adapter.ts`) と国内線対応は、2025年新エンジン
> `aswbe.ana.co.jp/webapps/*` 向けに用意してあります。路線・エンジンにより使い分けます。

## 仕組み（アーキテクチャ）

```
[ANAページのJS] --fetch/XHR--> ANAサーバ
        ▲ パッチ (document_start, MAINワールド)
[interceptor.ts]  --window.postMessage-->
[content.ts (ISOLATED)] --Port--> [service-worker (スイープ制御)] <--Port--> [サイドパネルUI]
```

- ANA は 2025 年に予約エンジンを刷新（`aswbe.ana.co.jp/webapps/*`）。本拡張はこの新エンジンの内部 JSON 通信を **fetch / XMLHttpRequest のフックで傍受**し、必要マイル・燃油・運航会社を構造化データとして取得します（DOM スクレイピングではありません）。
- スイープは **逐次（並列なし）+ ジッタ付き待機** で実行し、bot 検知リスクを抑えます。認証要求（HTTP 401/403/429・ログイン画面）を検知すると **自動的に一時停止**します。
- サービスワーカーは状態を `chrome.storage` に永続化し、停止・再起動後も再開できます。

## セットアップ

```bash
npm install
npm run build      # dist/ に拡張機能を出力
```

Chrome へ読み込み:

1. `chrome://extensions` を開く → **デベロッパーモード** を ON
2. **パッケージ化されていない拡張機能を読み込む** → `dist/` を選択
3. ツールバーのアイコンをクリックすると**サイドパネル**が開きます

## 使い方

1. ブラウザで **ANAマイレージクラブにログイン**し、特典航空券の検索ページを開く
2. サイドパネルの「検索」タブで条件を設定（路線・出発/目的地・期間・曜日・帰国オフセット・キャビン）
3. **スイープ開始**。進捗・発見件数を見ながら、必要なら一時停止/再開/中止
4. 「結果」タブでソート・フィルタ・CSV 出力

## ⚠️ 現状の重要な制約（要対応 / Phase 1〜2）

ANA の内部 API スキーマと DOM 構造は**非公開**のため、以下は実データに基づく調整が必要です。本リポジトリは**枠組みと安全側のフォールバック**まで実装済みで、フィールドのマッピングは「Dev capture」で実データを取得して確定します。

### Dev capture（スキーマ発見モード）の手順

1. サイドパネルの「Dev」タブで **Dev capture を有効化**
2. ログイン状態で **手動で特典航空券を1回検索**する
3. 「キャプチャをJSONでダウンロード」で、ANA ドメインの全 fetch/XHR 記録を取得
4. どの呼び出しが空席照会レスポンスかを特定し、フィールド名（必要マイル・燃油・運航会社・時刻）を確認
5. 以下を実データに合わせて更新:
   - `src/core/field-keys.ts` … 実際の JSON キー名を各候補配列の**先頭**に追記（全アダプタが追従）
   - `src/core/endpoints.ts` … 空席照会 URL の判定パターンを厳格化
   - `src/content/page-driver.ts`（`SELECTORS`）… フォーム自動入力のセレクタ。未設定の間は**手動検索モード**（ユーザーが手動検索し、傍受のみ行う）で動作します

### 実機キャプチャの着眼点（調査メモ）

ANA は 2025 年に予約エンジンを刷新済み。新エンジンは JS の SPA で、内部 JSON API は公開されていません（旧 `aswbe-i.ana.co.jp/international_asw/*.xhtml` は HTML レンダリングで対象外）。確認済みの新エンジンルート：

- `/webapps/reservation/roundtrip-flight-availability-international`
- `/webapps/reservation/flight-search`
- `/webapps/reservation/plan-list`
- **国際線アワードカレンダー（6ヶ月グリッド）** … 日付別空席を返す JSON XHR の最有力候補。まずここを DevTools の Network(Fetch/XHR) で観察するのが近道

クエリには `CONNECTION_KIND`（例 `JPN`/`LAX`/`ZZZ`）・`LANG`（`ja`/`en`）が付きます。応答 JSON では概ね次の名前が想定されます（`field-keys.ts` に候補登録済み）：必要マイル `requiredMiles`/`mileage`/`award`、燃油・税 `fuelSurcharge`/`YQ`/`tax`/`totalAmount`、運航/便名 `operatingCarrier`/`marketingCarrier`/`operatingFlightNumber`。運航会社フィールドが無い場合は**便名先頭2文字**（`NH###`=ANA、`UA`/`LH` 等=提携）で判定するフォールバックを実装済みです。キャビンは ANA 特典運賃コード `FS/CS/WS/YS` にも対応済み。

## 開発

```bash
npm run dev        # Vite 開発サーバ (HMR)
npm run typecheck  # 型チェック
npm test           # 単体テスト (Vitest)
```

### ディレクトリ

| パス | 役割 |
|------|------|
| `src/main-world/interceptor.ts` | MAIN ワールドで fetch/XHR をフックし傍受 |
| `src/content/content.ts` | 傍受データを SW へ中継・検索指示の受け渡し |
| `src/content/page-driver.ts` | 検索フォームの自動入力（要セレクタ設定） |
| `src/background/service-worker.ts` | Port 配線・永続化・dev capture |
| `src/background/sweep-orchestrator.ts` | スイープ制御（逐次・スロットル・リトライ） |
| `src/core/date-matrix.ts` | 期間×曜日×オフセット → ジョブ列 |
| `src/core/adapter*.ts`, `normalize.ts` | 生 JSON → 正規化結果行 |
| `src/panel/` | サイドパネル UI（フォーム・結果表・CSV・Dev） |
| `fixtures/` | テスト用の匿名化サンプル JSON |
| `test/` | Vitest 単体テスト |

### テスト戦略

- 認証が必要な実 ANA 通信は CI では行いません。`fixtures/` の匿名化 JSON に対してアダプタ/正規化/日付ロジック/傍受フックを検証します。
- ANA が API を変更した場合は、Dev capture で新しい応答を取得し、`fixtures/` とアダプタを更新してください。

### 手動 load-unpacked テスト手順

1. `npm run build` → `chrome://extensions` で `dist/` を読み込み
2. ANA にログイン → 新予約エンジンを開く → サイドパネルを開く
3. Dev capture ON → 手動検索1回 → キャプチャ表示・ダウンロードを確認
4. 小さなスイープ（例: 2日付）で逐次タイミング・進捗・結果・ソート/フィルタ・CSV を確認
5. 途中でログアウトを模擬し、一時停止挙動を確認
