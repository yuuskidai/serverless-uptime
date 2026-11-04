import type { ComponentHealth, Monitor } from './types';
import type { IncidentDetail } from './notifier';
import { safePublicWebUrl, redactPublicUrls, type PublicUrlContext } from './url-display';

type NotificationKind = 'down' | 'degraded' | 'partial' | 'up';
interface LayoutOptions {
  internal?: boolean;
  durationMs?: number;
  previousStatus?: 'down' | 'degraded';
}

/** Bound every dynamic value before building Slack's limited text objects. */
function clip(value: string, max: number, probeUrl?: PublicUrlContext): string {
  const clean = redactPublicUrls(value, probeUrl).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  if (clean.length <= max) return clean;
  let out = '';
  for (const char of clean) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return out + '…';
}
const plain = (text: string, max = 2000) => ({ type: 'plain_text', text: clip(text, max), emoji: true });
const section = (text: string) => ({ type: 'section', text: plain(text, 2900) });
const field = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${escapeMarkup(clip(value, 300))}`, verbatim: true });
function escapeMarkup(text: string): string {
  // Angle brackets can turn hostile health text into mentions or Slack links.
  // The other delimiters are stripped only in compact fields; details stay plain.
  return text.replace(/[*_~`]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Never put credentials, tokens in a query, or non-web schemes in action URLs. */
export function notificationServiceUrl(input: string): string | null {
  return safePublicWebUrl(input, true);
}

export function notificationTimeJst(observedAt?: number): string {
  const timestamp = observedAt ?? Date.now();
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return '観測時刻不明';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')} JST`;
}

function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '不明';
  if (ms < 1000) return '1秒未満';
  const total = Math.floor(ms / 1000);
  return [Math.floor(total / 3600) ? `${Math.floor(total / 3600)}時間` : '',
    Math.floor(total % 3600 / 60) ? `${Math.floor(total % 3600 / 60)}分` : '',
    total % 60 ? `${total % 60}秒` : ''].filter(Boolean).join('');
}

function componentSummary(components: ComponentHealth[], probeUrl: PublicUrlContext): string | null {
  if (!components.length) return null;
  const labels = { down: '異常', degraded: '遅延・一部不調', ok: '正常' };
  const lines = components.slice(0, 5).map(component => {
    const icon = component.status === 'down' ? '🔴' : component.status === 'degraded' ? '🟠' : '🟢';
    const latency = typeof component.latency_ms === 'number' && Number.isFinite(component.latency_ms) && component.latency_ms >= 0
      ? `｜${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(component.latency_ms)} ms` : '';
    return `${icon} ${clip(component.name, 100, probeUrl)}｜${labels[component.status]}${latency}` +
      (component.reason ? `\n   ${clip(component.reason, 200, probeUrl)}` : '');
  });
  if (components.length > 5) lines.push(`ほか ${components.length - 5} コンポーネント`);
  return `コンポーネントの状態\n${lines.join('\n\n')}`;
}

/** Pure presentation: delivery ownership, thresholds and incident state stay elsewhere. */
export function renderMonitorSlackMessage(
  monitor: Monitor, detail: IncidentDetail, kind: NotificationKind, options: LayoutOptions = {},
): { text: string; blocks: unknown[] } {
  const internal = options.internal === true;
  const normal = kind === 'up';
  const partial = kind === 'partial';
  const name = clip(redactPublicUrls(monitor.name, [monitor.url, monitor.fallback_url]).replace(/[\r\n\t]+/g, ' '), 100);
  const title = internal
    ? normal ? '🟢 内部経路が正常化' : partial ? '🔵 内部経路の応答が改善' : '🟠 内部経路の継続異常'
    : normal ? '🟢 復旧を確認' : partial ? '🟡 応答が回復・一部不調が継続' : kind === 'down' ? '🔴 公開サービスの異常' : '🟠 応答遅延・一部不調';
  const priority = normal ? '復旧確認' : internal ? '内部診断・要確認' : partial ? '継続確認' : kind === 'down' ? '高・要確認' : '注意・経過確認';
  const summary = internal
    ? normal ? '内部診断で連続した正常応答を確認しました。' : partial ? '内部経路は応答しましたが、一部不調が継続しています。' : '内部経路で異常が継続したため通知しています。'
    : normal ? options.previousStatus === 'degraded' ? '連続した正常チェックで遅延・一部不調の解消を確認しました。' : '公開HTTPSの監視で正常応答への復旧を確認しました。'
      : partial ? '応答は復旧しましたが、遅延または一部不調が継続しています。完全復旧はまだ確認していません。'
        : kind === 'down' ? '公開HTTPSの監視で異常応答を検知しました。利用状況と影響範囲を確認してください。' : '公開HTTPSの監視で応答遅延・一部不調を検知しました。';
  const observed = notificationTimeJst(detail.observedAt);
  const url = notificationServiceUrl(monitor.url);
  const fields = [field('優先度', priority), field('監視経路', internal ? '内部サービス接続' : '公開HTTPS'),
    field('対象サービス', url ? new URL(url).host : 'URL不明'), field('観測時刻', observed)];
  if (!internal && (partial || (normal && options.previousStatus !== 'degraded')) &&
    typeof options.durationMs === 'number' && Number.isFinite(options.durationMs) && options.durationMs > 0) {
    fields.push(field('監視上の停止期間', durationText(options.durationMs)));
  }
  const blocks: unknown[] = [
    { type: 'header', text: plain(`${title}｜${name}`, 150) },
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeMarkup(summary)}*`, verbatim: true } },
    ...(internal ? [section('公開サービスの稼働判定とは別の内部診断です。')] : []),
    { type: 'section', fields },
    { type: 'divider' },
  ];
  if (!normal && detail.reason) blocks.push(section(`原因・観測内容\n${clip(detail.reason, 700, [monitor.url, monitor.fallback_url])}`));
  const components = !normal ? componentSummary(detail.components, [monitor.url, monitor.fallback_url]) : null;
  if (components) blocks.push(section(components));
  const guidance = normal
    ? internal ? '追加対応の目安\n内部経路の正常化を確認しました。公開サービスの状態は、公開サービス監視の通知で確認してください。' : '追加対応の目安\n利用画面の応答も確認してください。再発した場合は、今回の原因・観測内容と照合してください。'
    : internal ? '🔎 対応の目安\n公開サービスの状態を先に確認し、内部接続・DB待機のログを調べてください。'
      : partial ? '🔎 対応の目安\n不調のあるコンポーネントを継続確認してください。完全復旧は同じスレッドへ返信します。'
        : '🔎 対応の目安\nサービス画面の応答と障害ログを確認してください。復旧は同じスレッドへ返信します。';
  blocks.push(section(guidance));
  const buttons: unknown[] = [];
  if (url) buttons.push({ type: 'button', text: plain('サービスを開く', 75), url, action_id: 'open_monitored_service' });
  buttons.push({ type: 'button', text: plain('Cloudflareを開く', 75), url: 'https://dash.cloudflare.com/', action_id: 'open_cloudflare_dashboard' });
  blocks.push({ type: 'actions', elements: buttons });
  blocks.push({ type: 'context', elements: [plain(internal ? '内部診断｜継続異常に絞って通知・正常化はスレッドへ返信' : '公開サービス監視｜観測時刻は検査時点・復旧はスレッドへ返信'),
    ...(detail.version ? [plain(`アプリ版 ${clip(detail.version, 64, [monitor.url, monitor.fallback_url])}`, 100)] : [])] });
  const text = clip(`${title}｜${name}｜${priority}｜${summary}${!normal && detail.reason ? ` 原因: ${clip(detail.reason, 500, [monitor.url, monitor.fallback_url])}` : ''}｜${observed}` +
    (internal ? '｜公開サービスの稼働判定とは別の内部診断です。' : ''), 2800);
  return { text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), blocks };
}
