# kuma-lite 連携 — 監視対象サイト側の実装依頼

このドキュメントは、kuma-lite ([yuuskidai/serverless-uptime](https://github.com/yuuskidai/serverless-uptime)) のステータスページに業務文脈ある情報を流すために、**監視対象サイト側で実装すべき API・挙動**を定めた契約書です。

監視対象（現状）:

| URL | 構築環境 | 業務名 |
| --- | --- | --- |
| `https://partner-portal.opus-system.workers.dev/` | Cloudflare Workers | パートナーポータル |
| `https://core-os.opus-system.workers.dev/` | Cloudflare Workers | Core OS |
| `https://partner-portal.opus-system.jp/` | Vercel | パートナーポータル |
| `https://project-os.opus-system.jp/` | Vercel | Project OS |

kuma-lite Worker URL: `https://kuma-lite.opus-system.workers.dev/`  
監視間隔: 1 分／cron / Bearer token 付き REST API。

---

## スコープ

優先度順に以下 3 件を実装してください:

1. **構造化 `/healthz` エンドポイント** — 必須。kuma-lite が「ただの 200 OK」ではなく「どのコンポーネントがどう不調か」を理解できるようにする。
2. **メンテナンス予告** — `/healthz` の一部として実装。計画停止が「障害」と誤検知されるのを防ぐ。
3. **自己申告インシデント push** — 任意。kuma-lite 側の cron を待たずに即時にステータスを反映させたい場合に使う。

---

## 1. 構造化 `/healthz`（必須）

### エンドポイント

```
GET /healthz
```

- 認証なし（公開）
- レスポンス時間 3 秒以内
- 内部で重い検査をする場合は **10 秒程度キャッシュ**して、毎呼び出しではなく定期的にプローブする実装でよい
- HTTP レスポンスヘッダ:
  - `Content-Type: application/json; charset=utf-8`
  - `Cache-Control: no-cache, no-store, must-revalidate`

### HTTP ステータスコード

| ステータス | 状況 |
| --- | --- |
| `200` | サービスは応答可能（`ok` または `degraded`） |
| `503` | サービスが利用不能（`down`） |

⚠️ **重要**: kuma-lite は HTTP レスポンスコードと JSON ボディの `status` フィールドを **両方** 見ます。一致しない場合（例: 200 OK だが `"status": "down"`）は、JSON 側を信用します。

### JSON スキーマ

```typescript
interface HealthResponse {
  /** 全体ステータス。`down` のときは HTTP も 503 を返すこと */
  status: 'ok' | 'degraded' | 'down';

  /** 現在のデプロイ識別子（commit SHA / tag / build id 等）。任意 */
  version?: string;

  /**
   * 不調時の理由を業務語で 1 文で。
   * - status === 'ok' のときは null/省略
   * - status === 'degraded' / 'down' のときは必須
   * 例: "決済処理 (Stripe) で応答遅延が発生しています"
   */
  reason?: string | null;

  /**
   * コンポーネントごとの健康状態。任意だが強く推奨。
   * 1 件以上あると、kuma-lite の障害詳細ページで「どこが」が表示される。
   */
  components?: ComponentHealth[];

  /** 計画メンテナンスの宣言。詳細は §2 */
  maintenance?: MaintenanceWindow | null;

  /** 任意の観測指標。詳細は §1.4 */
  recent_metrics?: RecentMetrics;
}

interface ComponentHealth {
  /** ユーザー向けの日本語名。例: "Database", "認証 (Auth0)", "決済 (Stripe)" */
  name: string;
  status: 'ok' | 'degraded' | 'down';
  /** プローブの応答時間（任意） */
  latency_ms?: number;
  /** degraded / down のときの説明（任意） */
  reason?: string | null;
}
```

### 例: 全部正常

HTTP `200`:

```json
{
  "status": "ok",
  "version": "8a1f3c2",
  "components": [
    { "name": "Database", "status": "ok", "latency_ms": 12 },
    { "name": "認証 (Auth0)", "status": "ok", "latency_ms": 80 },
    { "name": "決済 (Stripe)", "status": "ok", "latency_ms": 145 }
  ]
}
```

### 例: 一部劣化

HTTP `200`（`degraded` は 200 で返す。アクセスはまだできる）:

```json
{
  "status": "degraded",
  "version": "8a1f3c2",
  "reason": "決済 (Stripe) の応答が遅延しています",
  "components": [
    { "name": "Database", "status": "ok", "latency_ms": 14 },
    { "name": "認証 (Auth0)", "status": "ok", "latency_ms": 82 },
    { "name": "決済 (Stripe)", "status": "degraded", "latency_ms": 4200, "reason": "応答が 3 秒を超過 (通常 200ms 以内)" }
  ]
}
```

### 例: 全停止

HTTP `503`:

```json
{
  "status": "down",
  "version": "8a1f3c2",
  "reason": "データベース接続不可。すべての機能が利用できません",
  "components": [
    { "name": "Database", "status": "down", "reason": "接続プールが枯渇" },
    { "name": "認証 (Auth0)", "status": "down", "reason": "DB 不調により利用不可" },
    { "name": "決済 (Stripe)", "status": "down", "reason": "DB 不調により利用不可" }
  ]
}
```

### コンポーネント名の付け方（重要）

非技術者が読むので、**業務語**で命名してください。

| ❌ 避ける | ✅ 推奨 |
| --- | --- |
| `db_postgres` | `Database` |
| `redis_cache` | `セッションキャッシュ` |
| `stripe_webhook` | `決済 (Stripe)` |
| `auth0_jwks` | `認証 (Auth0)` |
| `s3_bucket_uploads` | `ファイル保存 (画像アップロード)` |
| `lambda_invocation` | (出さない、内部実装の漏出) |

含めるべきコンポーネント = **不調時にユーザーの体験が変わる外部依存**:
- 自社 DB
- 認証プロバイダ
- 決済プロバイダ
- 重要な外部 API
- メール配信

含めないでよいもの:
- インフラ詳細（ホスト名、AZ、コンテナ ID）
- 内部の細かい中継層（API ゲートウェイ自体）
- 認証情報・接続文字列・URL

### `recent_metrics` (任意)

直近 1 分間の観測指標を返すと、ステータスページで mini-chart を出せます（実装は将来）:

```json
"recent_metrics": {
  "requests_per_min": 1234,
  "error_rate": 0.012,
  "p95_latency_ms": 240
}
```

---

## 2. メンテナンス予告

`/healthz` レスポンスの `maintenance` フィールドで宣言します。

### スキーマ

```typescript
interface MaintenanceWindow {
  /** メンテ開始時刻 ISO 8601 with offset。必須 */
  from: string;
  /** メンテ終了予定時刻 ISO 8601 with offset。必須 */
  to: string;
  /** メンテ理由を業務語で。必須 */
  reason: string;
}
```

### 例: 1 時間後にメンテ予定（メンテ前）

```json
{
  "status": "ok",
  "components": [...],
  "maintenance": {
    "from": "2026-05-08T03:00:00+09:00",
    "to":   "2026-05-08T05:00:00+09:00",
    "reason": "DB バージョンアップに伴う計画停止"
  }
}
```

### 例: メンテ実施中（応答できない）

```json
{
  "status": "down",
  "reason": "計画メンテナンス実施中",
  "components": [...],
  "maintenance": {
    "from": "2026-05-08T03:00:00+09:00",
    "to":   "2026-05-08T05:00:00+09:00",
    "reason": "DB バージョンアップに伴う計画停止"
  }
}
```

### kuma-lite 側の挙動（参考）

- `from` の前: ステータスページ上部に **青い予告バナー**（カウントダウン付き）
- `from`〜`to`: バーが **青** で塗られ、Slack/Discord/RSS への DOWN 通知が抑止される
- `to` の後: `maintenance` フィールドを除去して通常運用に戻す

> 終了時刻 `to` を過ぎても `maintenance` が残っていると、復旧後も「メンテ中」表示が継続します。`to` 以降は **必ず `maintenance: null` に切り替えて**ください。

---

## 3. 自己申告インシデント push（任意）

監視対象側で「自分は今ダメ」と自己診断できる場合に、kuma-lite を待たずに即時反映させたい用途。

> ⚠️ kuma-lite 側のエンドポイントは **未実装** です。本契約書に従って kuma-lite 側に実装後にこのセクションが有効になります。一旦は #1 と #2 のみで運用開始。

### 想定エンドポイント

```
POST https://kuma-lite.opus-system.workers.dev/api/monitors/<monitor_id>/incident
Authorization: Bearer $KUMA_LITE_WRITER_TOKEN
Content-Type: application/json
```

```json
{
  "kind": "down",
  "reason": "外部認証 API が応答停止",
  "components": ["認証 (Auth0)"],
  "expected_recovery": "2026-05-08T22:30:00+09:00"
}
```

復旧時:

```
POST https://kuma-lite.../api/monitors/<id>/incident/resolve
{ "resolved_reason": "Auth0 復旧確認、再接続済み" }
```

### `monitor_id` の取得

```
GET https://kuma-lite.../api/monitors
Authorization: Bearer $KUMA_LITE_API_TOKEN
```
で各監視対象の id を確認できます。

---

## 4. 認証 / シークレット

| 用途 | 値 | 取得元 |
| --- | --- | --- |
| `/healthz` の呼び出し | なし（kuma-lite 側は公開エンドポイントを GET するだけ） | — |
| `/api/monitors/:id/incident` の呼び出し（§3 利用時） | `KUMA_LITE_WRITER_TOKEN` (Bearer) | kuma-lite 管理者から個別配布 |

監視対象側に置くシークレット:

- 監視対象から kuma-lite を呼び出す側の token は **環境変数のみ** に置く（リポジトリにコミット禁止）
- 既存の Vercel/Cloudflare の secret 機能を使う

---

## 5. 実装順序の推奨

### Phase 1（最優先 / 1〜2 日）

- [ ] 4 サイトすべてに `GET /healthz` を実装
- [ ] 全部 `ok` を返す素朴な実装で kuma-lite から疎通確認
- [ ] `version` フィールドにビルド SHA を入れる

### Phase 2（1〜2 日）

- [ ] `components` を埋める（最低 1 件: 自社 DB の health probe）
- [ ] 異常時に `status` を `degraded` / `down` に切り替えるロジックを追加
- [ ] `503` を返す経路を追加（DB 完全停止時など）

### Phase 3（必要時）

- [ ] `maintenance` フィールドの読み取りを実装（環境変数 or 設定 API でメンテ予告を入れられるようにする）
- [ ] `recent_metrics` を埋める（観測指標がすでに集計済みなら）

### Phase 4（任意）

- [ ] kuma-lite 側に push API が実装されたら、自己申告インシデント push を組み込む

---

## 6. 完了条件チェックリスト

各サイトで以下が満たされれば連携完了です。

### `/healthz` 基本

- [ ] `GET /healthz` が 3 秒以内に応答する
- [ ] レスポンスは `application/json; charset=utf-8`
- [ ] `Cache-Control: no-cache, no-store, must-revalidate` ヘッダ付き
- [ ] 認証不要でアクセスできる
- [ ] 正常時 HTTP `200` + `{"status": "ok", ...}`
- [ ] 完全停止時 HTTP `503` + `{"status": "down", "reason": "...", ...}`
- [ ] `version` にビルド識別子が入っている

### コンポーネント

- [ ] 1 件以上の `components` が含まれている
- [ ] コンポーネント名が日本語の業務語（`db_postgres` のような実装語ではない）
- [ ] 内部接続文字列・トークン・ホスト名がレスポンスに含まれていない
- [ ] 各コンポーネントの `status` がコンポーネント単位の検査結果を反映する

### メンテナンス

- [ ] `maintenance` フィールドを設定できる仕組みがある（env var, admin API, 設定ファイル等）
- [ ] `to` 経過後に自動的に `null` に戻る、または手動で外せる運用が定まっている
- [ ] `from` / `to` がタイムゾーン込みの ISO 8601 形式で出力される

### 動作確認

- [ ] kuma-lite 側で `https://kuma-lite.opus-system.workers.dev/` を開き、対象サイトのステータスバーが「正常」と表示されること
- [ ] 監視対象を意図的に劣化させた状態（DB 接続切断など）で `/healthz` が `503` + `down` を返し、kuma-lite に「停止中」と表示されること
- [ ] メンテ宣言時に kuma-lite の DOWN 通知（Slack/Discord）が抑止されること

---

## 7. リリース後の運用

### 観測

- ステータスページ: <https://kuma-lite.opus-system.workers.dev/>
- 障害履歴 RSS: <https://kuma-lite.opus-system.workers.dev/rss.xml>
- 障害発生時に Slack #cloudflare--webhook に自動通知

### 連絡

- kuma-lite の不具合・要望: [yuuskidai/serverless-uptime](https://github.com/yuuskidai/serverless-uptime) の Issue
- 監視対象側で `/healthz` の応答仕様変更を行う場合は事前に共有

---

## 8. 参考: kuma-lite 側の関連コード

実装の挙動を確認したい場合の参照先（読み込み専用、変更は別 PR で）:

- `kuma-lite/src/monitor.ts` — cron で `/healthz` (現状はトップ URL) を取得・判定するロジック
- `kuma-lite/src/kinds.ts` — エラーカテゴリ分類（HTTP コード別の業務語見出し）
- `kuma-lite/src/incident-page.ts` — 障害詳細ページの render
- `kuma-lite/src/rss-feed.ts` — RSS 生成

将来の `components` 表示・`maintenance` 表示は kuma-lite 側に追加実装が必要です（本契約成立後の別 PR）。

---

## 9. 不明点・質問

このドキュメントだけで実装に着手できるよう、追記・修正が必要な箇所があれば
[yuuskidai/serverless-uptime](https://github.com/yuuskidai/serverless-uptime) の Issue で連絡してください。
