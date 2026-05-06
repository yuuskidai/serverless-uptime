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
- DOWN 検知／復旧時の通知（Discord Webhook、および chat-sdk 経由の Slack）
- Slack の `/kuma` スラッシュコマンドで現在のサマリを返答
- 直近 24 時間のアップタイム率と、過去 90 分間のタイムラインを表示する
  パブリックなステータスページ
- Bearer トークン認証付きの監視対象 CRUD API
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

### 1. 依存パッケージのインストールと D1 データベースの作成

```bash
cd kuma-lite
npm install
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

- **Bot Token Scopes**: `chat:write`, `commands`
- **Slash Commands**: `/kuma` を追加し、Request URL を
  `https://kuma-lite.<your-subdomain>.workers.dev/slack/events` に設定
- **Event Subscriptions**: 不要（`/status` は slash command のみ使用）

bot をチャンネルに招待 (`/invite @kuma-lite`) するのを忘れずに。

### 4. デプロイ

```bash
npx wrangler deploy
```

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
    "name": "Example",
    "url": "https://example.com",
    "expected_status": 200,
    "keyword": null,
    "timeout_ms": 10000,
    "interval_minutes": 1,
    "retry_threshold": 2
  }'
```

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

監視対象のフィールド：

| フィールド         | 型       | 既定値  | 備考                                 |
| ------------------ | -------- | ------- | ------------------------------------ |
| `name`             | string   | —       | 必須                                 |
| `url`              | string   | —       | 必須、`http(s)://…` のみ受け付け     |
| `method`           | string   | `GET`   |                                      |
| `expected_status`  | number   | `200`   |                                      |
| `keyword`          | string   | `null`  | 指定時はレスポンスに含まれる必要あり |
| `timeout_ms`       | number   | `10000` | `[1000, 30000]` にクランプ           |
| `interval_minutes` | number   | `1`     | `[1, 60]` にクランプ                 |
| `retry_threshold`  | number   | `2`     | この回数連続で失敗したら通知         |
| `enabled`          | boolean  | `true`  |                                      |

## ローカル開発

```bash
npx wrangler d1 execute kuma-lite-db --file=./schema.sql --local
npx wrangler dev

# Cron ハンドラを手動で発火：
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

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
