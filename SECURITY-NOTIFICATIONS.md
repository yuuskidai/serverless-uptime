# セキュリティ通知の運用

`opus-system.jp` の Cloudflare Zone は Free を維持する。有料オプションや外部監視サービスは追加しない。Workers、Durable Objects、ログなどの利用量は既存アカウントの枠を消費するため、利用量課金が常にゼロになるという意味ではない。

## 通知経路

| 対象                   | 検知・通知経路                                                                                | 判断できること                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| HTTP DDoS              | Cloudflare の標準 `dos_attack_l7` ポリシー → 既存 Slack Webhook 宛先                          | Cloudflare が検知・緩和した毎秒 100 リクエスト超の HTTP 攻撃         |
| WAF の遮断・チャレンジ | Cloudflare GraphQL Security Events → `helth-security` → `helth` の専用 Slack RPC              | 入口で検知された攻撃の疑い・防御動作                                 |
| 認証・権限・重要設定   | Core OS / Partner Portal → アプリ別の Service Binding RPC → `helth-security` → 専用 Slack RPC | ログイン失敗の集中、アカウントロック、権限拒否の集中、重要設定の変更 |

通知は侵入の確証として扱わない。正規利用者の誤入力や正当な管理操作でも記録される。WAF のサンプルデータでは全未遂の検知を保証できず、盗まれた正しい認証情報によるアクセスの正当性も WAF 単体では判定できない。

WAF の取得範囲は `opus-system.jp` Zone 配下の上記 2 ホスト。`workers.dev` への直接アクセスはこの Zone の WAF 取得範囲には含まれない。アプリ内の認証・権限イベントはアクセス先ホストにかかわらず対象だが、任意の HTTP 攻撃全般を検知するものではない。

WAF は Free 向けの `firewallEventsAdaptive` サンプル記録から、処理区分・対象ホスト・時刻だけを取得して Worker 内で集計する。Cloudflare 固有の `string` 型と型付きフィルターを使用する。取得上限 1,000 件に達した区間も既知の観測は処理し、欠測を UNKNOWN と履歴に残してカーソルを一度だけ進める。256 KiB を超える応答は不正な応答として拒否し、完全取得と扱わない。

Free の標準 DDoS 通知にはドメイン・ホスト・閾値のフィルタがない。アカウント全体の対象通知となり、WAF イベント集計とアプリの監査通知では Core OS / Partner Portal に対象を固定する。標準 WAF Security Events Alert は Business 以上のため、今回の方式では使用しない。

## 集計と通知の基準

| 観測                                                             | 初期の通知基準                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| パスワード・二段階認証等の失敗                                   | 同一アプリ・識別子で 5 分枠に 5 件、またはアプリ全体で 20 件            |
| 認証試行制限・権限拒否                                           | 同一アプリ・識別子で 5 分枠に 10 件、またはアプリ全体で 50 件           |
| アカウントロック                                                 | DB が新たなロックを保存したとき。既にロック済みのアクセスは再通知しない |
| 管理者権限・個人の二段階認証無効化・会社の二段階認証必須設定解除 | 実際の保存成功後、別のイベント ID ごとに通知                            |
| WAF の遮断・チャレンジ・検知記録                                 | 対象ホスト・処理区分ごとの初回観測から通知し、同種の反復は 15 分間抑止  |

5 分枠は最初の観測を起点とする枠で、厳密な移動窓ではない。集計通知も同種・同一識別子では 15 分間抑止する。アプリ送信には isolate 内の上限があり、WAF にはサンプリングがあるため、通知件数は受け付けた観測数であり全試行数ではない。

認証試行の拒否には、制限超過に加えて保存先障害時の安全側の拒否も含まれる。通知文は拒否の集中という観測事実を示し、攻撃や制限超過を原因として断定しない。

通知保存は最大 128 件・UTC 日ごと最大 200 件に制限する。通常通知、重要設定変更、アカウントロック、監視基盤の異常には別々の枠を予約し、重要設定変更を先に配送する。上限到達・取得失敗を「攻撃なし」に置き換えない。WAF は毎分、約 90 秒の反映待ちを置いた確定時間帯を取得し、遅延時は一回最大 5 分を回収する。回収できない欠測や API 制限は監視基盤の警告として扱う。

## 信頼境界と秘密情報

- アプリからの受付は `CoreSecurityEvents` / `PortalSecurityEvents` の名前付き Worker RPC のみ。公開 HTTP にイベント受付や Slack 送信 API を作らない。送信元アプリ名は受付側が固定する。
- `helth-security` は `SECURITY_HUB` の SQLite Durable Object で集計・再送状態を保持し、`SLACK_NOTIFIER` Service Binding から `helth` の `SecurityNotifications` を呼ぶ。
- Slack トークン・通知先は既存 `helth` の設定を使う。アプリや集計 Worker に Slack トークンを配布しない。任意の通知先・任意の Slack ペイロードは受け付けない。
- パスワード、OTP、Cookie、セッショントークン、メールアドレス、URL のクエリ、リクエスト本文を通知・イベントに含めない。人物・ネットワークの集計識別子は HMAC で仮名化する。
- `CF_ANALYTICS_TOKEN` は分析の読み取り専用トークンを設定する。`ADMIN_SECRET` は制御用であり、ログや公開レスポンスに含めない。

## 分析 API の最小権限

GraphQL の WAF 取得が権限不足の場合、Cloudflare の Custom API Token に次を設定する。

1. Permissions: **Zone → Analytics → Read**。
2. Zone Resources: **Include → Specific zone → opus-system.jp**。
3. 有効期限と保管方法を確認し、トークンを `helth-security` の **`CF_ANALYTICS_TOKEN`** Secret に設定する。

Account Analytics、Zone の編集、DNS の編集、請求権限はこのゾーンのイベント読取には不要。トークン値をチャット・Git・ログへ貼り付けない。Secret 設定後は読み取りクエリの成功と次の自然実行を確認する。未設定や権限エラーを「攻撃なし」と扱わない。

Cloudflare 標準 DDoS ポリシーの登録には、設定作業用の **Account → Notifications → Edit** が別途必要。この編集権限を WAF 読取 Worker に渡さない。Workers や D1 を編集できる作業用トークンを `CF_ANALYTICS_TOKEN` に流用しない。

## 実行・配信の確認

公開 `/healthz` は Worker の生存確認であり、イベントの網羅性や Slack 配信成功の保証ではない。認証付き `/admin/status` と構造化ログで、次を確認する。

- 監視の実行状態、直近 WAF 取得時刻と成功・権限不足・欠測。
- アプリの受付件数、重複抑止、集計閾値到達。
- 未配信・再試行・打切り・上限到達の件数。
- Slack への成功応答と再送時刻。429、通信切断、応答不明を成功として扱わない。

配信状態は SQLite に保存し、外部送信は保存トランザクションの外で行う。Slack 受領後に応答が失われる場合など、ネットワーク越しの厳密な一回限り配信は保証できない。同じ通知 ID を維持し、重複を追跡できるようにする。

配信失敗の打切り記録は累積件数と安全な受領記録に残す。管理者が確認後に認証付き・本文なしの `POST /admin/acknowledge` で確認済みにできるが、未配信・実行中・WAF 取得不能の間は拒否する。確認済みにしても履歴・累積件数は削除しない。

アプリ側のイベント送信は認証処理と別の `waitUntil` で実行する。通知障害を理由に認証を迂回したり、認証処理を長時間待機させたりしない。このためアプリでの操作成功と監査通知の保存は単一の原子的トランザクションではない。

## リリース確認

- CI は `kuma-lite` の依存関係を固定バージョンでインストールし、`kuma-lite`、`health-witness`、`security-alerts` の型検査とテストを実行する。
- 新 Worker の DO マイグレーションと Service Binding を確認する。通知 Worker は業務 D1 に接続しない。既存の監視 D1 マイグレーションを再適用しない。
- アプリ配備に以前の未反映の認証対策が含まれる場合は、先に実環境の migration 台帳とスキーマを照合する。通知機能のために業務テーブルを追加せず、認証対策に必要な未適用分だけを別に記録・検証する。今回の初回反映では、既存 70 件を維持し、TOTP 再利用防止用の `0071_20261024_totp_replay_state.sql` のみを適用した。
- アプリの `SECURITY_EVENTS` が、それぞれ対応する名前付きエントリーポイントを参照していることを確認する。
- Zone が Free のままで、有料プラン・追加オプションが購入されていないことを確認する。
- 変更の配信結果、API の実権限、自然イベントの観測、実際の Slack 受領は別々に記録する。コードやバインディングの存在だけで「本番通知確認済み」としない。

## 公式資料

- [Notifications とプラン](https://developers.cloudflare.com/notifications/)
- [DDoS 通知と制限](https://developers.cloudflare.com/ddos-protection/reference/alerts/)
- [WAF 標準通知のプラン制限](https://developers.cloudflare.com/waf/alerts/)
- [Security Events とサンプリング](https://developers.cloudflare.com/waf/analytics/security-events/)
- [API 権限一覧](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
