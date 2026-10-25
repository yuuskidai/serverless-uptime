# kuma-lite

Cloudflare のサーバーレス基盤（**Workers + D1 + Cron Triggers**）だけで動作する、
Uptime Kuma 風の最小構成な監視サービスです。常時起動のコンテナや専用の DB
サーバーは不要で、小規模用途であれば無料枠の範囲で運用できます。

> このディレクトリは本リポジトリ（[louislam/uptime-kuma](https://github.com/louislam/uptime-kuma)
> のフォーク）に追加された **オリジナル実装** です。Uptime Kuma 本体のコードは
> 再利用しておらず、ユーザー体験を参考に新規に書き起こしたものです。
> ライセンスは上流と同じ MIT License で、ルートの [`LICENSE`](../LICENSE) と
> [`NOTICE`](../NOTICE) を参照してください。

## 機能

- HTTP/HTTPS エンドポイントの死活監視（最短 1 分間隔）
- ステータスコード／レスポンスタイム／レスポンスボディのキーワード検査
- タイムアウト・連続失敗回数（フラッピング抑制）の設定
- DOWN／DEGRADED 検知時と復旧時の通知（Discord Webhook、および chat-sdk 経由の Slack）
- Slack の `/kuma` スラッシュコマンドで現在のサマリを返答
- 直近 60分／12時間／24時間／7日／30日 を切り替えて閲覧できる、
  非技術者向けに最適化したパブリックなステータスページ
  - 障害詳細ページは HTTP コード別 (5xx の中でも 500 / 502 / 503 / 504 を区別) に
    具体的な原因表現を出し、業務機能名 (`description`) を併記できる
- **構造化 `/healthz` 連携**（[`docs/integration-spec.md`](./docs/integration-spec.md)）:
  監視対象側が JSON で `status` / `reason` / `components` / `maintenance` を返すと、
  バーが業務語の理由をそのまま表示し、計画メンテナンス窓は青塗り＋通知抑制になる
- **フォールバック URL**: `/healthz` 自体が落ちても、`fallback_url` で素朴な
  死活確認を継続する。アプリ層のヘルスチェックの不具合で監視全体が盲目化しない
- Bearer トークン認証付きの監視対象 CRUD API（`description` で各監視対象に
  業務文脈を流し込み可能）
- 古い check 行を自動削除する日次クリーンアップ（保持日数は設定可）

## アーキテクチャ

```
            ┌──────────────────┐
  毎分      │  Cron Trigger    │
   ───────▶│  scheduled()     │──▶ runChecks() ──┬─▶ 各監視先に fetch
            └──────────────────┘                  ├─▶ checks へ INSERT
                                                  ├─▶ monitor_state を UPSERT
            ┌──────────────────┐                  └─▶ 状態遷移時に Discord/Slack へ通知
  03:00   ─▶│  Cron Trigger    │──▶ cleanupOldChecks()  (古い行を DELETE)
   UTC      └──────────────────┘

            ┌──────────────────┐
  HTTP    ─▶│  fetch()         │──▶ /              renderStatusPage()
                                 ├─▶ /api/monitors  handleApiRequest()
                                 ├─▶ /slack/events  chat-sdk webhook（/kuma 等）
                                 └─▶ /healthz       ヘルスチェック

            ┌──────────────────┐
  Queue   ─▶│  queue()         │──▶ handleRcaBatch()  DOWN/DEGRADED 通知の原因を AI で推定
            └──────────────────┘                      Slack スレッドへ返信（任意）
```

状態は D1 の 3 テーブルで保持します：

- `monitors` — 監視対象の定義
- `checks` — 個々のチェック結果（`RETENTION_DAYS` 経過後にクリーンアップで削除）
- `monitor_state` — 現在の up/down、連続失敗回数、`down_since`（復旧時の
  ダウン継続時間レポート用）

## 前提：Cloudflare 環境の準備

セットアップに進む前に、Cloudflare 側の環境を整えておきます。すべて無料枠で
完結します。

### 1. Cloudflare アカウント

<https://dash.cloudflare.com/sign-up> から無料アカウントを作成し、メール検証
を済ませます。クレジットカードの登録は不要です（Workers の無料プランで動作
します）。

サインインして <https://dash.cloudflare.com/?to=/:account/workers-and-pages>
を開き、「Workers」と「D1」が利用できる状態であることを確認します。初回は
Workers のサブドメイン（例：`<your-subdomain>.workers.dev`）の選択を求められ
るので、任意の名前を決めておきます。

### 2. ローカル環境

| ツール | 用途 | バージョン目安 |
| --- | --- | --- |
| Node.js | wrangler の実行 | 18 以上（推奨 20 LTS） |
| npm | 依存解決 | Node.js 同梱版で OK |
| Git | リポジトリ取得 | 任意のバージョン |

```bash
node -v   # v20.x.x など
npm -v
```

### 3. Wrangler CLI のインストールとログイン

`wrangler` は本リポジトリの `kuma-lite/` 内では `npx wrangler` 経由で実行する
ので、ローカルへの追加インストールは必須ではありません。ただし最初の一度だけ
Cloudflare アカウントとひも付ける必要があります。

```bash
cd kuma-lite
npm install
npx wrangler login
```

ブラウザが開き、Cloudflare の OAuth 同意画面が表示されます。承認すると
ローカルにトークンが保存されます。CI 環境などブラウザを開けない場合は、
`https://dash.cloudflare.com/profile/api-tokens` から「Edit Cloudflare Workers」
テンプレートで API トークンを発行し、`CLOUDFLARE_API_TOKEN` 環境変数に
設定してください。

```bash
export CLOUDFLARE_API_TOKEN="<発行したトークン>"
```

ログイン状態の確認：

```bash
npx wrangler whoami
```

### 4. Discord Webhook URL の取得

DOWN／復旧通知に使います。

1. Discord サーバーの設定 → 連携サービス → ウェブフック → 「新しいウェブフック」
2. 投稿先チャンネルとアイコン（任意）を設定
3. 「ウェブフック URL をコピー」で取得

通知が不要な場合は後述の `wrangler secret put DISCORD_WEBHOOK_URL` をスキップし
ても動きます（その場合、通知関数はサイレントに何もしません）。

### 5.（任意）Cloudflare MCP の接続

Claude Code から D1 や Worker を直接確認したい場合、Cloudflare 公式 MCP
サーバーを接続しておくと、デプロイ後に `d1_database_query` などのツールが
利用可能になります。

`~/.config/claude-code/mcp.json` に以下を追記：

```json
{
  "mcpServers": {
    "cloudflare": {
      "url": "https://bindings.mcp.cloudflare.com/mcp"
    }
  }
}
```

Claude Code を再起動するか `/mcp` コマンドを実行すると、初回は OAuth で
Cloudflare の認証フローに飛びます。承認すると以下のツールがセッション内で
使えるようになります（一例）：

- `accounts_list` / `set_active_account`
- `workers_list` / `workers_get_worker` / `workers_get_worker_code`
- `d1_databases_list` / `d1_database_query`
- `search_cloudflare_documentation`

## セットアップ

### 1. 依存パッケージのインストールと wrangler 設定の作成

```bash
cd kuma-lite
npm install
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` は gitignore されており、各環境の値はローカル限定で管理します。
テンプレートからコピーした上で、以下の手順で自分の環境の値を埋めていきます。

```bash
npx wrangler d1 create kuma-lite-db
```

出力された `database_id` を `wrangler.toml` に貼り付けます。

```toml
[[d1_databases]]
binding = "DB"
database_name = "kuma-lite-db"
database_id = "<ここに貼り付け>"
```

### 2. スキーマの適用

```bash
npx wrangler d1 execute kuma-lite-db --file=./schema.sql --remote
```

ローカル開発時は `--remote` を `--local` に置き換えてください。

#### 既存 DB の段階アップグレード

新規構築なら `schema.sql` 一発で完結します。既に運用中の DB に対しては
`migrations/` 配下の差分 SQL を順番に適用してください。

```bash
npx wrangler d1 execute kuma-lite-db --file=./migrations/0002_healthz_integration.sql --remote
```

`0002_healthz_integration.sql` は `/healthz` 構造化対応で追加された列
（`monitors.fallback_url`、`checks.healthz_*`、`monitor_state.maintenance_*`）を
ALTER で追加します。冪等ではないため、適用済みの環境で再実行するとエラーに
なります（その場合は無視して構いません）。

#### 0009: 監視実行の重複防止と通知状態の更新

`0009_monitor_execution.sql` は **監視 Worker `helth` が既に使っている監視用 D1**
への差分です。Core OS / Partner Portal の業務用 D1 に適用しないでください。
新しい Worker や DB は作りません。`schema.sql` は新規 DB 用で、既存 DB の
更新には使いません。0008 まで適用された既存 DB に 0009 を一度だけ適用します。

既存のデプロイ設定で Worker 名、`DB` binding の接続先、二つの Cron 設定を
確認・記録します。本番への反映時は次の順で切り替えます。

1. 監視の Cron を一時停止し、旧バージョンの実行が終了したことを確認します。
   旧コードは新しい lease / CAS を参照しません。新旧の処理を重ねたままでは、
   旧処理による状態上書きまで防ぐことはできません。すでに動いている処理の
   終了を Logs 等で確認してから進めてください。
2. `kuma-lite` ディレクトリで固定 lockfile の依存を用意し、検証します。

   ```bash
   npm ci --ignore-scripts
   npm run typecheck
   npm test
   ```

   テストには Node.js 24 と、インストール済み Wrangler の workerd / D1 を使います。
   テストはローカル DB のみで実行され、Cloudflare アカウントには接続しません。
3. 接続先が既存の監視 DB であることと未適用であることを確認し、差分を適用します。

   ```bash
   ./node_modules/.bin/wrangler d1 execute kuma-lite-db \
     --file=./migrations/0009_monitor_execution.sql --remote
   ```

   `ALTER TABLE` を含むため再実行できません。エラー時は成功扱いにせず、
   列・index・table の適用状態を確認してから復旧してください。新コードは
   必須列が欠けていると schema gate で監視処理を止めます。
4. 確認済みの新バージョンを既存 `helth` Worker へデプロイし、旧バージョンが
   残っていないことを確認してから、元の `* * * * *` と `0 3 * * *` を戻します。
   新版は分ごとの予定時刻を slot にし、日次 cleanup は別経路として処理します。
5. 新しい slot ごとのチェックが監視ごとに一件であること、
   `monitor_state.last_check_slot` が前へ進むこと、旧版の書き込みがないことを確認します。

実行権は D1 の時計で 120 秒後に失効します。中断された slot を再実行することは
ありません。失効後の新しい slot から再開するため、異常終了時には監視に空白が
生じる場合があります。古い runner は結果・状態・通知 thread を更新できません。
通知の直前にも所有権を確認して最低 30 秒の実行権を確保し、通知処理には別途
時間上限を設けます。外部通知先との分散トランザクションはないため、送信先が
受信した後の応答消失等では通知の到達を確定できません。同じ slot の自動再送はしません。

DOWN 判定は既存の連続 `retry_threshold` 回（既定 2 回）のままです。
DOWN から DEGRADED は部分復旧として扱い、DEGRADED から完全復旧は連続する
正常応答が同じ閾値に達してから通知します。メンテナンス中の通知抑制が終わっても
異常が続いている場合は、その異常を一度通知します。

旧 `latency_threshold_ms` の正の安全整数は DB 専用の
`db_latency_threshold_ms` に引き継ぎます。HTTP 全体の閾値
`http_latency_threshold_ms` は `NULL` のままで、明示設定するまで有効になりません。
新しい DB 閾値を明示的に `NULL` にした場合、旧列への fallback はしません。

相関ID・段階計測・部分復旧と完全復旧・AI分析の公開仕様は
[health-monitoring-contract.md](docs/health-monitoring-contract.md) を参照してください。

### 3. シークレットの登録

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL   # Discord の Incoming Webhook URL
npx wrangler secret put API_TOKEN             # 任意のランダム文字列（Bearer トークン）
```

トークンの生成例：`openssl rand -hex 32`

#### Slack 連携（任意）

Slack の bot token と signing secret を登録すると、DOWN/復旧通知が Slack にも
飛び、`/kuma` スラッシュコマンドが利用可能になります（`/status` は Slack 予約名
のため使えません。`/kuma-status` も同じハンドラに紐付いています）。

```bash
npx wrangler secret put SLACK_BOT_TOKEN        # xoxb-...
npx wrangler secret put SLACK_SIGNING_SECRET   # Slack App の Signing Secret
```

通知を流すチャンネルは `wrangler.toml` の `[vars]` に
`SLACK_DEFAULT_CHANNEL = "C0123ABCD"` として設定します（チャンネル ID は
チャンネル右クリック → リンクをコピーで取得できる末尾の文字列）。

Slack App 側の設定ポイント:

- **Bot Token Scopes**: `chat:write`, `commands`, `reactions:write`
  （`reactions:write` は復旧時に DOWN メッセージへ ✅ リアクションを付ける
  ために必須。後から追加した場合は **「Install App → Reinstall to Workspace」**
  を忘れずに）
- **Slash Commands**: `/kuma` を追加し、Request URL を
  `https://kuma-lite.<your-subdomain>.workers.dev/slack/events` に設定
- **Event Subscriptions**: 不要（`/status` は slash command のみ使用）

bot をチャンネルに招待 (`/invite @kuma-lite`) するのを忘れずに。

#### AI による原因推定（任意）

Slack 連携を有効にしたうえで以下を設定すると、DOWN・DEGRADED 通知のスレッドに AI が
推定した原因（根拠となるログ行・次に確認すべきこと付き）が自動で返信されます。
cron の監視処理を LLM 呼び出しで止めないよう、通知後に Cloudflare Queues
へジョブを積み、Queue consumer 側で分析・返信します（`src/rca.ts`）。

推論は Workers AI binding（`env.AI.run`）経由で行うため、請求は Cloudflare に
一本化されます。

- 既定モデルは Workers AI 上の `@cf/deepseek-ai/deepseek-v4-pro-0813`
  （汎用の推論モデル、100 万トークンのコンテキスト、入力 $1.32 / 出力 $3.96
  per M tokens）。通常の Workers AI 利用料として請求され、Workers Paid プランが
  必要です。
- `RCA_MODEL` で AI カタログの任意のモデルに切り替えられます。安く済ませたい
  場合は `@cf/deepseek-ai/deepseek-v4-flash-0731`、Claude を使いたい場合は
  `anthropic/claude-opus-5`（AI Gateway の Unified Billing で課金されるため、
  ダッシュボードの **AI → AI Gateway** でクレジットの事前チャージが必要。
  購入額に 5% の手数料）。
- `RCA_AI_GATEWAY` で経由する AI Gateway を指定できます（既定は初回利用時に
  自動作成される `default`）。

分析に渡す材料:

- D1 の直近 30 分の `checks`（ステータスコード・エラー・healthz の内容）
- Workers Logs のエラーイベント（Workers Observability Telemetry Query API）
- 対象 Worker のデプロイ履歴（`RCA_WORKER_SCRIPTS` で対応付けた監視のみ）
- Cloudflare 自体の未解決インシデント（cloudflarestatus.com）

```bash
npx wrangler queues create kuma-lite-rca
npx wrangler secret put CF_API_TOKEN         # 任意: Workers Observability Read + Workers Scripts Read
npx wrangler secret put CF_ACCOUNT_ID        # 任意: 上記トークンのアカウント ID
npx wrangler secret put RCA_WORKER_SCRIPTS   # 任意: {"1":"partner-portal"} のような 監視ID→Worker名 の JSON
```

`wrangler.toml` の末尾にある `[ai]` / `[[queues.producers]]` / `[[queues.consumers]]`
のコメントを外してデプロイします。Workers Builds を使う場合は、環境変数
`RCA_QUEUE_NAME=kuma-lite-rca` を設定すると `build-wrangler-toml.mjs` が追記します。
`RCA_QUEUE` と `AI` のどちらかの binding が無い間は機能全体が無効です。

注意点:

- `head_sampling_rate = 0.1` のため fetch のログは 1 割しか残りません。監視対象の
  Worker 側もサンプリングしていると、原因のログが材料に含まれないことがあります。
- ログ・エラー文字列は外部由来のデータなので、プロンプト上はデータとして扱うよう
  指示しており、bot の権限はスレッドへの投稿のみです。

### 4. デプロイ

ローカルから直接デプロイする場合:

```bash
npx wrangler deploy
```

Cloudflare Workers Builds (master push で自動デプロイ) を使う場合は、
`wrangler.toml` がリポジトリに無い (`.gitignore` 済) ため、build VM 側で
テンプレートから生成する必要があります。Workers Builds の Settings →
Build configuration で以下を設定します。

- **Environment variables** (Build & Deploy 両方で参照可)
  - `D1_DATABASE_ID` — `wrangler d1 list` で表示される uuid
  - `WRANGLER_SERVICES` — `BINDING=service` を comma 区切りで列挙
    (例: `PARTNER_PORTAL=partner-portal,CORE_OS=core-os`)。同一アカウント
    内の他 Worker への bare fetch は 1042 で失敗するため、ここに binding
    を宣言してから monitor 行の `service_binding` 列で参照する。
- **Build command**: `npm ci && node scripts/build-wrangler-toml.mjs`
- **Deploy command**: `npx wrangler deploy` (デフォルトのまま)

`scripts/build-wrangler-toml.mjs` が `wrangler.toml.example` から実値入りの
`wrangler.toml` を生成 → 続く `wrangler deploy` がそれを使ってデプロイします。

`packageManager` は `npm@11.21.1` に固定しています。Workers Builds は依存の
自動インストール前にこの指定を適用します。既定の npm 10.9.2 ではこの lockfile の
依存 override を正しく解決できず `npm ci` が失敗するため、版指定を維持してください。

Worker は `https://kuma-lite.<your-subdomain>.workers.dev` で公開されます。
`wrangler.toml` に設定した Cron Trigger は自動的に発火を始めます。

- `* * * * *` — 毎分、対象になっているチェックを実行
- `0 3 * * *` — 毎日 03:00 UTC、`RETENTION_DAYS` を超えた `checks` を削除

### 5. 監視対象の追加

```bash
curl -X POST https://kuma-lite.<subdomain>.workers.dev/api/monitors \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Auth Service",
    "url": "https://auth.example.com/health",
    "description": "ログイン・認証 API",
    "expected_status": 200,
    "keyword": null,
    "timeout_ms": 10000,
    "interval_minutes": 1,
    "retry_threshold": 2
  }'
```

`description` は任意。指定すると、ステータスページのカードと障害詳細ページの
ヘッダに、URL の隣に **業務機能名** として表示されます。非技術者の閲覧者は
URL ではなく機能名でサービスを認識できます。

`https://kuma-lite.<subdomain>.workers.dev/` を開けばステータスページが表示されます。

## API

すべてのエンドポイントで `Authorization: Bearer $API_TOKEN` ヘッダが必須です。

| Method | Path                | Body                       | 説明                       |
| ------ | ------------------- | -------------------------- | -------------------------- |
| GET    | `/api/monitors`     | —                          | 監視対象の一覧取得         |
| POST   | `/api/monitors`     | 下記フィールドを含む JSON  | 監視対象の追加             |
| GET    | `/api/monitors/:id` | —                          | 1 件の取得                 |
| PATCH  | `/api/monitors/:id` | 部分的なフィールド         | 更新                       |
| DELETE | `/api/monitors/:id` | —                          | 監視対象と履歴をまとめて削除 |

### RSS フィード

`GET /rss.xml`（または `/feed`）で直近 30 日分の障害履歴を RSS 2.0 形式で配信
します。RSS リーダーで購読すると、新規発生した障害と復旧通知が自動的に届き
ます。配信内容:

- `<title>`: `[障害発生] サービス名 (説明) — システムエラー` のような形式
- `<description>`: 原因カテゴリ・発生時刻・復旧時刻 (または「現在も継続中です」)・影響時間
- `<link>`: 該当する障害詳細ページへの URL
- `<pubDate>`: 復旧時刻 (継続中なら発生時刻)

RSS リーダーは `<head>` の `<link rel="alternate" type="application/rss+xml">`
を経由して自動的にフィードを発見します。

監視対象のフィールド：

| フィールド         | 型       | 既定値  | 備考                                 |
| ------------------ | -------- | ------- | ------------------------------------ |
| `name`             | string   | —       | 必須。表示名 (例: `Auth Service`)    |
| `url`              | string   | —       | 必須、`http(s)://…` のみ受け付け。構造化 `/healthz` を返すサイトでは末尾を `/healthz` にしておく |
| `description`      | string   | `null`  | 任意。業務機能名や説明文 (例: `ログイン・認証 API`)。最大 500 文字。ステータスページのカードと障害詳細ページに `name` の下に表示され、非技術者でも何のサービスか把握しやすくなる |
| `fallback_url`     | string   | `null`  | 任意、`http(s)://…`。`url` が JSON で応答しない／到達不能のときに代わりにプローブする。構造化ヘルスチェックが落ちてもサイト本体の死活監視を継続できる |
| `service_binding`  | string   | `null`  | 任意。同一 Cloudflare アカウント内の別 Worker を監視するときに、`wrangler.toml` で宣言した service binding 名（例: `PARTNER_PORTAL`）を指定。同一アカウント内 Worker への bare fetch は Cloudflare ランタイムが `error code: 1042` で遮断するため、その回避手段として使う。binding 自体は `wrangler.toml` 側で `[[services]]` を追加し再デプロイ後に有効になる |
| `method`           | string   | `GET`   |                                      |
| `expected_status`  | number   | `200`   |                                      |
| `keyword`          | string   | `null`  | 指定時はレスポンスに含まれる必要あり |
| `timeout_ms`       | number   | `10000` | `[1000, 30000]` にクランプ           |
| `interval_minutes` | number   | `1`     | `[1, 60]` にクランプ                 |
| `retry_threshold`  | number   | `2`     | この回数連続で失敗したら通知         |
| `enabled`          | boolean  | `true`  |                                      |
| `probe_transport` | string | `legacy` | `public_fetch` は公開HTTPS、`service_binding` は指定した内部bindingを使用。明示した経路は自動で切り替えない |
| `monitor_role` | string | `availability` | `availability` は公開稼働判定、`diagnostic` は内部経路の運用通知、`shadow` は記録のみ。診断・shadowは公開画面やRSSへ出さない |
| `parent_monitor_id` | number / null | `null` | 診断・shadowが対応する公開監視ID。公開監視には親を指定しない |
| `response_mode` | string | `legacy_http` | `strict_healthz` はHTTP・JSON・Database計測・キャッシュ抑止を検証し、入口画面の応答でhealth失敗を解消しない |
| `config_revision` | number | サーバー管理 | 設定更新ごとに進み、旧設定で開始した要求の記録・通知を拒否する。APIからの指定不可 |
| `availability_since_ms` | number / null | サーバー管理 | 公開HTTPS監視へ切り替えた時刻。過去の内部監視を公開HTTPSの実績として集計しない。APIからの指定不可 |

経路変更は進行中の障害や有効な実行leaseがある場合に409を返します。設定変更・欠測を跨ぐ観測は連続失敗として数えません。
監視自身の `/healthz` はプロセスの死活確認、`/readyz` は公開監視データの鮮度確認です。
公開チェックが欠測・古い場合は `/readyz` が503を返し、公開画面も現在の状態を「未確認」と表示します。
設定・段階切替・ロールバックの詳細は [監視契約](docs/health-monitoring-contract.md) を参照してください。

> **業務情報の流し込みについて。** kuma-lite は HTTP レベルの自動診断しか
> できないため、障害詳細ページに表示される説明文（例: 「システムエラー」「応答遅延」）
> はあくまで技術的な分類です。閲覧者は「**どの業務機能**で問題が起きたのか」
> も知りたいので、`description` で業務機能名 (例: `ログイン機能`、`決済`、`管理画面`)
> を渡しておくと、URL の隣に並び、閲覧者は「ログイン機能で応答遅延が発生していた」
> という形で文脈を理解できます。さらに業務文脈に沿った文面で告知したい場合は、
> 監視対象側 (kuma-lite を呼び出す側) から `description` を更新する運用を
> 想定しています。

## ローカル開発

```bash
npx wrangler d1 execute kuma-lite-db --file=./schema.sql --local
npx wrangler dev

# Cron ハンドラを手動で発火：
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## 同一 Cloudflare アカウント内の Worker を監視する場合

監視対象が kuma-lite と同じ Cloudflare アカウントの Worker の場合、bare
`fetch()` で `*.workers.dev` URL を叩くと Cloudflare ランタイムが
`error code: 1042` (同一 zone 再帰防止ガード) を返して失敗します。
これは Cloudflare Access の Bypass を設定しても回避できません。

回避策: `wrangler.toml` で対象 Worker への service binding を宣言し、
monitor row の `service_binding` 列に binding 名をセットします。

### 1. `wrangler.toml` に binding を追加

```toml
[[services]]
binding = "PARTNER_PORTAL"
service = "partner-portal"   # 対象 Worker の名前 (dashboard で確認)

[[services]]
binding = "CORE_OS"
service = "core-os"
```

### 2. デプロイ

`master` への push で Cloudflare Workers Builds が自動デプロイします。
Binding はデプロイ完了後に有効になります。

### 3. monitor 側で binding を指定

```bash
curl -X PATCH https://kuma-lite.<subdomain>.workers.dev/api/monitors/5 \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"service_binding": "PARTNER_PORTAL"}'
```

`url` は引き続き元の URL (`https://<your-domain>/healthz`)
で OK。Service binding は HTTP path / method / headers をそのまま転送
するため、コード側の変更は不要です。

## 既存環境を `/healthz` 構造化監視に切り替える手順

監視対象側の `/healthz` 実装が完了している前提で、本番 D1 に対して以下を一度
だけ実行します。

```bash
# 1. スキーマ差分の適用 (idempotent ではないので、適用済みなら無視可)
npx wrangler d1 execute kuma-lite-db \
  --file=./migrations/0002_healthz_integration.sql --remote

# 2. デプロイ
npx wrangler deploy

# 3. 既存 monitor の url を /healthz に切り替え、fallback_url にトップ URL を入れる
#    (例: id=1 が <your-domain> を見ているケース)
curl -X PATCH https://kuma-lite.<subdomain>.workers.dev/api/monitors/1 \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-domain>/healthz",
    "fallback_url": "https://<your-domain>/"
  }'
```

切り替え直後の cron で構造化レスポンスを拾い始めます。`/healthz` が JSON で
返ってこない・タイムアウトする・接続できない場合は `fallback_url` で素朴な
200 判定にフォールバックするため、監視がブラックアウトすることはありません。

## 運用上の注意

- **サブリクエスト上限。** 1 回の Cron 起動で発生するサブリクエストは「対象数 ＋
  数件の D1 呼び出し」で、Workers 無料プランでは 1 起動あたり 50 件が上限です。
  チェックは 40 件ずつのバッチに分割しているため余裕を持って収まりますが、
  対象数が概ね 40 を超えたら有料プラン（$5/月、上限 1000）への移行か、複数
  Worker への分割を検討してください。
- **CPU 時間。** Cron の CPU 上限は通常十分ですが、大量の監視を捌く場合は
  発火タイミングを少しずらした 2 つ目の Cron に半分を逃がす設計が無難です。
- **保持期間。** `wrangler.toml` の `RETENTION_DAYS` を増やせば履歴を長期保持
  できます。D1 無料枠（5GB）であれば、小規模運用なら数年分でも収まります。
- **非公開モニター。** `[vars]` で `HIDDEN_MONITOR_IDS = "3,7"` のように指定
  すると、該当 ID をパブリックなステータスページから除外できます（チェック
  自体は引き続き実行されます）。

## Cloudflare MCP での確認

デプロイ後、Cloudflare 公式 MCP サーバーを使って Claude Code のセッション内
から本番 D1 や Worker を直接確認できます。よく使うクエリの例：

```sql
-- 直近のチェック結果
SELECT m.name, c.status, c.status_code, c.latency_ms, c.error,
       datetime(c.ts/1000, 'unixepoch') AS at
  FROM checks c JOIN monitors m ON m.id = c.monitor_id
 ORDER BY c.ts DESC LIMIT 20;

-- 現在 down 状態の監視対象
SELECT m.name, ms.consecutive_failures,
       datetime(ms.down_since/1000, 'unixepoch') AS down_since
  FROM monitor_state ms JOIN monitors m ON m.id = ms.monitor_id
 WHERE ms.current_status = 'down';
```

`d1_database_query` ツールで実行できます。`workers_get_worker_code` を使えば、
本番にデプロイされているコードがこのディレクトリと一致しているかも確認可能
です。

## 制限事項 / 非ゴール

- HTTP/HTTPS のみ対応（Workers の制約上 TCP / ICMP / DNS プローブは不可）
- 最短間隔は 1 分（Cron Trigger の粒度）
- ステータスページはリクエスト時にレンダリングする HTML（WebSocket での
  リアルタイム更新はなし）
- マルチテナント認証は持たず、API は単一の共有 Bearer トークンで保護

## ライセンス

MIT License。本リポジトリ全体は上流の Uptime Kuma と同じ MIT で配布されます。
詳細はリポジトリルートの [`LICENSE`](../LICENSE) と、フォークおよび追加分の
位置づけを述べた [`NOTICE`](../NOTICE) を参照してください。
