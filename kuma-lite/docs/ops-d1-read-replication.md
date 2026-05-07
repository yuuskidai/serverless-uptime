# Ops: D1 Read Replication を有効化する

`claude/fix-database-performance-JnkLo` ブランチで kuma-lite の read paths
(`/`, `/incident`, `/rss.xml`) は D1 Sessions API
(`env.DB.withSession('first-unconstrained')`) を使うようになりました。
この変更だけでは効果が出ず、**Cloudflare 側で D1 のレプリケーション設定を
切替えて初めて読み取りが近接コロから返るようになります**。

このドキュメントは、その切替手順をデスクトップ側で実施するためのメモです。

## 何が変わるか

- Before: 読み取りは APAC (SIN) のプライマリへ往復。RTT 30–80ms 観測。
- After (auto モード): 同一リージョン or 近接リージョンのレプリカから読まれる。
  - APAC からの visitor: ほぼ同じ(プライマリが近いため)
  - 北米/欧州 visitor: RTT が大幅に短縮(<20ms 期待)
- 書き込みは引き続きプライマリ。Sessions API の bookmark で
  read-your-own-writes 整合性は維持される。

コード側はレプリケーション無効でも問題なく動く(プライマリのみ使う形に
graceful degrade)ので、この切替は **任意のタイミングで** 行ってよい。

## 前提

- API トークン: `kuma-lite/.env` の `CLOUDFLARE_API_TOKEN`
  - スコープに「D1: Edit」が必要。既存トークンが `wrangler deploy` 用で
    Edit 権限なら同じものを使ってよい。権限不足なら
    [Cloudflare ダッシュボード → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
    で新規発行か既存トークンの編集を。
- アカウント / DB ID:
  - `CLOUDFLARE_ACCOUNT_ID` = `ba6339e31e01a9bc4e2036728864bae2` (opus-system)
  - D1 database id = `2f9aa24f-2a0d-496b-ab08-1cd76dcf04cc` (kuma-lite-db)

## 手順

### A. ダッシュボード経由(推奨・1 クリック)

1. https://dash.cloudflare.com/ でログイン
2. **Workers & Pages → D1 → kuma-lite-db** を開く
3. **Settings** タブ → **Read Replication** セクション
4. モードを `Auto` に変更して保存

### B. API 経由(自動化したい場合)

`kuma-lite/.env` を読み込んで `curl` を打つ:

```bash
set -a
source kuma-lite/.env
set +a

curl -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/2f9aa24f-2a0d-496b-ab08-1cd76dcf04cc" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"read_replication":{"mode":"auto"}}' \
  | jq '.result.read_replication'
```

期待されるレスポンス:

```json
{ "mode": "auto" }
```

## 確認

切替後、以下で `mode: "auto"` になっていれば成功:

```bash
curl -s \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/2f9aa24f-2a0d-496b-ab08-1cd76dcf04cc" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  | jq '.result.read_replication'
```

実際にレプリカ経由で読まれているかは、Worker のレスポンスヘッダ
`x-d1-served-by-region` または Workers Logs で確認できる(D1 Sessions API
が応答に含めるメタデータ)。

## ロールバック

問題が出たら同じ API で `mode: "disabled"` に戻す:

```bash
curl -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/2f9aa24f-2a0d-496b-ab08-1cd76dcf04cc" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"read_replication":{"mode":"disabled"}}'
```

コード側は `disabled` でもそのまま動くので、切戻しはこの 1 本だけで完了する。

## 関連リンク

- Cloudflare D1 Read Replication ドキュメント: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Sessions API リファレンス: https://developers.cloudflare.com/d1/api/d1-database/#withsession
- 該当コード: `src/status-page.ts`, `src/incident-page.ts`, `src/rss-feed.ts`
  の `env.DB.withSession('first-unconstrained')` 呼び出し箇所
