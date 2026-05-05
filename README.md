# serverless-uptime

> このリポジトリは [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma)
> のフォークで、Cloudflare Workers 専用の軽量実装 **kuma-lite** を追加することを
> 目的にしています。
>
> This repository is a fork of [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma).
> The fork's purpose is to add **kuma-lite**, a lightweight reimplementation
> targeting Cloudflare Workers + D1.

---

## このフォークの内容 / What this fork contains

| 場所 / Location | 説明 / Description |
| --- | --- |
| [`kuma-lite/`](./kuma-lite) | Cloudflare Workers + D1 + Cron Triggers で動く Uptime Kuma 風の監視サービス。**本フォークでの追加分**で、上流コードは再利用しないオリジナル実装。詳細・[Cloudflare 環境の準備](./kuma-lite/README.md#前提cloudflare-環境の準備)・セットアップ手順は [`kuma-lite/README.md`](./kuma-lite/README.md)。<br>An original (non-derivative) Uptime-Kuma-style monitoring service that runs on Cloudflare Workers + D1 + Cron Triggers. Cloudflare account/Wrangler/MCP setup and full instructions live in [`kuma-lite/README.md`](./kuma-lite/README.md). |
| その他すべて / Everything else (`src/`, `server/`, `public/`, `docker/`, …) | 上流 Uptime Kuma の **未改変** のコード。<br>Upstream Uptime Kuma sources, **unmodified**. |

## 上流 Uptime Kuma について / About upstream Uptime Kuma

本家 Uptime Kuma 本体（同梱されている `src/`, `server/`, `docker/` 等）の
ドキュメント・Live Demo・インストール手順・スポンサー・コントリビュート方法は、
**すべて上流リポジトリを参照してください**。

For documentation, live demo, installation, sponsorship, and contribution
guidance for upstream Uptime Kuma itself, **please refer to the upstream
repository**:

- 📖 README: <https://github.com/louislam/uptime-kuma#readme>
- 📚 Wiki: <https://github.com/louislam/uptime-kuma/wiki>
- 🐛 Issues: <https://github.com/louislam/uptime-kuma/issues>
- 💬 Subreddit: <https://www.reddit.com/r/UptimeKuma/>
- ❤️ Sponsors: <https://github.com/sponsors/louislam> / <https://opencollective.com/uptime-kuma>

直近で同期した時点の上流 README のスナップショットは
[`README.upstream.md`](./README.upstream.md) に保存されています（参考用）。
最新の正本はあくまで上流リポジトリ側です。

A snapshot of the upstream README at the most recent sync is kept in
[`README.upstream.md`](./README.upstream.md) for convenience. The upstream
repository remains the source of truth.

## ライセンス / License

MIT License。

- 上流分: Copyright © 2021 Louis Lam（[`LICENSE`](./LICENSE) を保持）
- 本フォーク追加分（`kuma-lite/` 等）: 同じく MIT License で配布
- フォークの構成・著作権の整理は [`NOTICE`](./NOTICE) を参照

The fork is distributed under the MIT License. The upstream copyright notice
in [`LICENSE`](./LICENSE) is preserved as required, and additions made by this
fork are also released under the MIT License. See [`NOTICE`](./NOTICE) for
attribution details.

## メンテナンス / Maintenance notes

- `README.upstream.md` は GitHub Actions
  ([`.github/workflows/sync-upstream-readme.yml`](./.github/workflows/sync-upstream-readme.yml))
  により定期的に上流の README に追従します。手動で更新したい場合は
  `workflow_dispatch` で起動するか、ローカルで以下を実行してください：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/louislam/uptime-kuma/master/README.md \
    -o README.upstream.md
  ```
- 上流から `git merge` で同期するとき、本ファイル（`README.md`）は本フォーク
  の内容を残してください（`git checkout --ours README.md`）。
