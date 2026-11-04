# 旧 Node 監視の依存修正

このディレクトリは旧 Node アプリ用です。Cloudflare の `kuma-lite`、
`health-witness`、`security-alerts` の配備・設定・依存には適用しません。
旧 Node アプリのビルドと実行には Node.js 22以上を使用します。

公式修正版がある依存はロックに固定しています。Nodemailer10、tar7、
undici6、UUID11などで major が変わる箇所は CommonJS の実 consumer と
ローカル通信・MIME生成・添付・TLS設定・アーカイブの回帰を確認します。
Axios は既存0系 API を保つ修正版0.34、protobufjs は7系を維持します。

glob10 と minimatch9 は既存の public API を保つため、公式修正を
バックポートしました。上流バージョンは偽らず、各 `SECURITY_PATCH.json`
に元の npm archive の SHA512/SHA256、修正commit、全ファイルhashを保存します。

- glob: `4682e8c9`。AbortSignalで中断後のディレクトリ読取を止め、
  待機callbackを正しく解放します。
- minimatch: `77a0f5c4`。level2のパス分岐を `braceExpandMax` で制限し、
  1000件を超える集合の二次時間の重複除去を省略します。

旧 consumer の minimatch3.1.5 /5.1.9 は当該level2処理を実装していません。
元archive・実ファイルhash・既知の単一advisory・実consumer回帰を確認した
場合のみ非該当に分類し、元のバージョン一致を監査結果から消しません。

`npm ci` は `.npmrc` の `install-links=true` に従って実ソースを梱包し、
worker用の独立lockに混ぜません。`npm run setup` は現在の修正済みソースから
フロントをビルドしてdev依存を除去します。上流タグへのcheckoutや古い配布物の
ダウンロードでセキュリティ修正を取り消す経路にはしていません。
Dockerを作る場合もNode22以上のbase2を使用し、古いbaseはbuild時に拒否します。

検証は次の順序で実行します。

```sh
npm ci
npm run test:dependency-security
npm run audit:dependencies
npm run build
```

`audit:dependencies` は固定の公開OSV snapshotをGETし、全root lockと
実際のinstallをローカルで照合します。非公開の依存graphを監査APIへPOSTしません。
保存snapshotを指定する場合は `--database=... --database-metadata=...` を使います。
全ZIP/CRC・hash・鮮度・全lock/inventory・実ソースと回帰を検証し、未知のadvisory、
未確認のソース、欠落した非optional依存は成功扱いにしません。公式deprecated警告や
OSVのraw一致は残り得るため、「警告ゼロ」と「検証後に要対応ゼロ」は区別します。
