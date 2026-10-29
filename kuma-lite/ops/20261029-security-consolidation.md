# セキュリティ通知のhelthへの統合（2026-10-29）

目的は`helth-security`を減らし、既存のセキュリティ受付・集計・WAF参照・通知を`helth`内で維持すること。
`SecurityHub`本体、singleton名`fixed-security-hub-v1`、DB内容・所有権・世代・Alarm・通知IDと再送方針は変えない。
主系とshadowの2分・DB警告1500ms・HTTP期限10秒・連続2回も維持する。

## 事前準備

- 旧WorkerのGit連携を切断し、`kuma-lite/**`の変更で旧Workerが再配備されないようにする。
- `helth`の`CF_ANALYTICS_TOKEN`に、既存ZoneのAnalytics Readだけを持つ資格情報を設定する。
  管理用トークンを流用しない。トークン値をチャット・ファイル・ログへ出さず、旧トークンは切替確認まで維持する。
- namespace名・所有Worker・安全なSQL投影でenabled、generation、active有無、pending、送信/失敗件数、WAF状態を記録する。
  rawイベント、ownership token、通知payload、シークレット値は取得しない。
- アプリ側は実配備c981を基準としたconfig-only差分を準備する。旧ローカルcheckoutから再buildしない。

## 配備と検証

1. `helth`に既存Core/Portal named entrypoint、既存SecurityHubの薄いadapterと既存API_TOKEN保護の管理経路を追加する。
   DO内のSlack配送は既存`deliverSecurityAlert`へ直結し、自己Service BindingやSlack資格情報の複製を作らない。
2. destinationの最初のDO migrationに`transferred_classes`を指定する。`new_classes`/`new_sqlite_classes`で先に作成せず、
   `deleted_classes`も適用しない。migration tagは`security-hub-transfer-20261029`。
3. 既存namespaceの所有先が`helth`になり、保存状態・世代が維持され、自然なAlarmとWAF取得が継続することを確認する。
   `start`/`stop`/`acknowledge`や人工イベント、手動Slack送信で検証しない。
4. Core/Portalの本番`SECURITY_EVENTS`を`helth.CoreSecurityEvents`/`helth.PortalSecurityEvents`へ切り替える。
   HMAC設定・entrypoint名・他資源・Preview未接続契約を保持する。旧DO bindingの自動転送は移行中の橋渡しだけに使う。
   アプリ本体の再配備・main/release pushは既定の許可範囲外で、必要な場合は具体的差分と検証結果で判断する。
5. 主系・shadowとセキュリティの自然実行を確認し、全callerが旧Workerを参照しなくなった後に、
   旧Worker本体の永久削除を直前確認する。移管済みnamespaceを削除してはいけない。
6. 旧WAFトークンを識別して、利用先の切替確認後に失効する。共有管理/Buildトークンを推測だけで失効しない。

## 運用境界と復旧

- このtransfer設定はproduction専用。Workers Buildsの`WORKERS_CI_BRANCH!=master`は設定書き込み前に停止する。
  直接の`wrangler preview`、新規Preview作成、他Worker名での適用も行わない。
- migrationは一度適用されると旧versionへの通常rollbackでは越えられない。問題があれば移管済みのnamespace・tagを維持し、
  修正版をforward deployする。旧Workerへのcreate/delete migrationや世代resetで戻さない。
- 管理経路は`GET /api/security/status`、bodyless `POST /api/security/start|stop|acknowledge`。
  private statusのrecentDeadなどは、通常の本番検証では読み出さない。
- `security-alerts`は共有ライブラリとして保持する。旧deploy configは削除し、helperからのdeploy/devも拒否する。
- Cloudflare管理・配備の資格情報と、常駐Workerの読み取り資格情報は用途を分離する。
  管理用の編集権限を常駐Workerへ渡すための一本化は行わない。

仕様: [legacy transfer](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#transfer-migration)、
[rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)。
