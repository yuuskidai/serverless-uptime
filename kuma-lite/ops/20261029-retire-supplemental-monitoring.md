# 補助監視の廃止（2026-10-29）

Worker数と検査負荷を減らすため、Cloudflare witnessとGitHub外部監視を廃止する。
主系とshadowの4本は同じ`helth` Worker上で維持し、2分間隔・DB警告1500ms・HTTP期限10秒・連続2回を変更しない。

## 反映順序

1. GitHubの`External HTTPS witness` workflowを無効化し、実行中・待機中のrunがないことを確認する。workflow定義も削除する。
2. `helth`から補助表示と取得処理、外部観測POSTの受付、witness Service Bindingを除去して配備する。
   GETの管理APIと履歴テーブルは残す。受信は本文・認証・D1にアクセスせず410を返す。
   ビルドスクリプトは古い環境変数に残るwitness bindingを除外し、再配備で復活させない。
3. `helth-witness`に`RETIRED=true`の版を配備する。新規startを拒否し、次のAlarmで定期検査を停止する。
   世代・履歴・所有権・進行中状態をリセットせず、次回予定とAlarmだけを解除する。
4. `/latest`の安全な停止情報で、retired・無効状態・次回Alarmなしを確認する。
   退役時に進行中だった状態が残る場合、完了や強制解除とは扱わない。
5. witnessのGit連携を切断し、以後のmaster pushで再配備されないことを確認する。
6. 主系・shadowの自然監視継続と本番UIを確認後、`helth-witness`の削除直前に対象と永続データへの影響を確認する。

`helth-witness`のWorker削除は、その配備版と専用Durable Object保存データにも影響する。
主系のD1、過去の検査・通知・外部観測履歴、既存の調査資料、GitHubの過去runは削除しない。
この変更で遅延・503の根因が確定・解消したとは扱わない。

## 復元

自動復元・再開は行わない。再開が必要な場合は、Git履歴からコードと設定をレビューし、
GitHub workflow、受信口、binding、witnessの退役設定とGit連携を明示的に復元する。
Workerや専用DOを削除した後は、同名Workerを作り直しても元のDOデータの復元にはならない。
