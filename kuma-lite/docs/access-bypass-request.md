# `/healthz` を Cloudflare Access から除外する依頼

> 依頼先: `yuuskidai/sales-ops-platform`
> 依頼日: 2026-05-07
> 依頼元: kuma-lite (`yuuskidai/serverless-uptime`)
> 関連 spec: [`integration-spec.md`](./integration-spec.md) §1 (認証なし公開)

## 状況

PR #5 を反映後、kuma-lite から監視対象 4 サイトの `/healthz` を構造化監視に切り替えました。Vercel 側 2 サイトは正常に取得できていますが、**Cloudflare Workers 側 2 サイトの `/healthz` が Cloudflare Access (Zero Trust) でガードされており、外部からアクセスできない状態**です。

| 監視対象 | URL | 状況 |
| --- | --- | --- |
| Partner Portal (Vercel) | `https://partner-portal.opus-system.jp/healthz` | OK (200, 構造化 JSON) |
| Project OS (Vercel) | `https://project-os.opus-system.jp/healthz` | OK (200, 構造化 JSON) |
| **Partner Portal (Cloudflare)** | `https://partner-portal.opus-system.workers.dev/healthz` | **NG (Access による 302 リダイレクト)** |
| **Core OS (Cloudflare)** | `https://core-os.opus-system.workers.dev/healthz` | **NG (Access による 302 リダイレクト)** |

外部から `curl` で `/healthz` を叩いた際の応答 (Cloudflare 側):

```
HTTP/1.1 302 Found
Www-Authenticate: Cloudflare-Access resource_metadata="..."
Location: https://opus-system.cloudflareaccess.com/cdn-cgi/access/login/partner-portal.opus-system.workers.dev?...
```

## 仕様上の要件 ([`integration-spec.md`](./integration-spec.md) §1)

```
GET /healthz

- 認証なし（公開）
- レスポンス時間 3 秒以内
- HTTP レスポンスヘッダ:
  - Content-Type: application/json; charset=utf-8
  - Cache-Control: no-cache, no-store, must-revalidate
```

`/healthz` は kuma-lite が定期的に外部から叩く必要があるため、**認証なしでアクセス可能であること**が契約条件です。業務 API は引き続き Access で守った上で、`/healthz` だけ Bypass するのが正しい運用です。

## 依頼内容

Cloudflare Zero Trust ダッシュボードで、以下 2 アプリケーションの `/healthz` パスに対して Bypass ポリシーを追加してください。

### 設定手順 (Zero Trust ダッシュボード)

各アプリケーションごとに以下を実施します:

1. <https://one.dash.cloudflare.com/> を開く
2. **Access > Applications** を開く
3. 「**Add an application**」をクリック → **Self-hosted** を選択
4. アプリケーション設定:
   - **Application name**: `partner-portal /healthz bypass` (Core OS は `core-os /healthz bypass`)
   - **Session Duration**: 任意 (Bypass なので影響なし)
   - **Application domain**:
     - Subdomain: `partner-portal` (Core OS は `core-os`)
     - Domain: `opus-system.workers.dev`
     - **Path**: `healthz`
5. 「Next」→ ポリシー作成画面で:
   - **Policy name**: `Public healthz`
   - **Action**: **Bypass**
   - **Configure rules**: Selector = `Everyone` (すべてのリクエストを認証スキップ)
6. 残りの設定はデフォルトで「Add application」

Cloudflare Access はパスがより具体的なアプリケーションを優先するため、上記の `/healthz` 用アプリケーションが既存の `/*` 用アプリケーションより先に評価されます。

### 対象アプリケーション

| アプリ名 (例) | Subdomain | Domain | Path |
| --- | --- | --- | --- |
| `partner-portal /healthz bypass` | `partner-portal` | `opus-system.workers.dev` | `healthz` |
| `core-os /healthz bypass` | `core-os` | `opus-system.workers.dev` | `healthz` |

## 完了確認方法

設定後、外部から以下が成功することを確認してください:

```bash
curl -i https://partner-portal.opus-system.workers.dev/healthz
curl -i https://core-os.opus-system.workers.dev/healthz
```

期待:
- HTTP `200` (`Location:` ヘッダが付かないこと)
- `Content-Type: application/json; charset=utf-8`
- ボディが構造化 JSON (`{"status":"ok",...}` 等)

設定完了後、kuma-lite 側で以下を実施し監視を再開します (kuma-lite 担当の作業):

```bash
# 該当 monitor を有効化 (現在は false positive 表示を避けるため一時無効化中)
curl -X PATCH https://kuma-lite.opus-system.workers.dev/api/monitors/5 \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

curl -X PATCH https://kuma-lite.opus-system.workers.dev/api/monitors/6 \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

## 補足: なぜ Service Token / mTLS ではなく Bypass か

代替案として「kuma-lite に Cloudflare Access Service Token を持たせて認証付きで `/healthz` を叩く」方法もありますが、

1. spec §1 が「認証なし公開」を契約条件として規定している
2. 監視ループに認証情報を持ち回すと、トークン失効・rotation の運用コストが発生
3. `/healthz` は構造化レスポンスから内部情報が漏れない設計 (DB 接続文字列・スキーマ名・実装語をすべて除外済み) なので、公開してもセキュリティリスクが上がらない

ため、**`/healthz` のみ Bypass** が最も保守性とセキュリティのバランスが良い選択です。

## 質問・連絡先

設定で不明点があれば `yuuskidai/serverless-uptime` の Issue で連絡してください。
