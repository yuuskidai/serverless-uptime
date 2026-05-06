/*
 * SlackWorkersAdapter — a Cloudflare Workers-native implementation of the
 * chat-sdk `Adapter` interface for Slack.
 *
 * This is intentionally a *subset* of the official `@chat-adapter/slack`:
 * it uses fetch + Web Crypto (no axios, no @slack/socket-mode, no node:crypto)
 * and supports the slash-command + outbound-message flow that kuma-lite needs.
 *
 * Out of scope (deliberately stubbed): modals/views, file uploads, native
 * streaming, scheduled messages, OAuth installation flows, message history.
 *
 * Compatible with `chat@^4.27.0`.
 */

import {
  type Adapter,
  type AdapterPostableMessage,
  type Author,
  type ChannelInfo,
  type ChatInstance,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  type MessageData,
  type RawMessage,
  type ThreadInfo,
  type UserInfo,
  type WebhookOptions,
  toPlainText,
} from 'chat';

import { ValidationError } from './errors';
import { SlackClient } from './client';
import { verifySlackRequest } from './signing';

const ADAPTER_NAME = 'slack';

export interface SlackAdapterConfig {
  /** Bot token (xoxb-...). Required. */
  botToken: string;
  /** Signing secret used to verify inbound webhooks. Required for handleWebhook. */
  signingSecret?: string;
  /** Override Slack API base URL (defaults to https://slack.com/api/). */
  apiUrl?: string;
  /** Optional preset bot user id; if omitted it is fetched lazily via auth.test. */
  botUserId?: string;
  /** Bot username for @-mention matching. Defaults to "bot". */
  userName?: string;
  /** Custom logger. Defaults to ChatInstance's logger when initialized. */
  logger?: Logger;
}

/** Slack-specific thread id payload. */
export interface SlackThreadId {
  channel: string;
  threadTs: string;
}

/** Slack message envelope; we store the raw event JSON for `RawMessage.raw`. */
export type SlackRawMessage = Record<string, unknown>;

/**
 * Encode a Slack channel + thread_ts into the canonical "slack:CXXX:1234.5678"
 * thread id used by chat-sdk.
 */
export function encodeSlackThreadId(data: SlackThreadId): string {
  return `slack:${data.channel}:${data.threadTs}`;
}

/**
 * Decode "slack:CXXX:1234.5678" back into channel + threadTs.
 *
 * Tolerates an optional trailing colon-suffix appended by chat-sdk for
 * subscoped threads; we treat anything past the third colon as part of
 * the thread id segment.
 */
export function decodeSlackThreadId(threadId: string): SlackThreadId {
  const parts = threadId.split(':');
  if (parts.length < 3 || parts[0] !== 'slack') {
    throw new ValidationError(ADAPTER_NAME, `Invalid Slack thread id: ${threadId}`);
  }
  return {
    channel: parts[1] ?? '',
    threadTs: parts.slice(2).join(':'),
  };
}

function rootText(text: string): FormattedContent {
  return {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value: text }],
      },
    ],
  } as FormattedContent;
}

function postableToText(message: AdapterPostableMessage): {
  text: string;
  blocks?: unknown[];
} {
  if (typeof message === 'string') return { text: message };
  if (message && typeof message === 'object') {
    const m = message as unknown as Record<string, unknown>;
    if (typeof m.raw === 'string') return { text: m.raw };
    if (typeof m.markdown === 'string') return { text: m.markdown };
    if (m.ast) {
      // Best-effort: stringify the mdast AST to plain text. The official
      // adapter renders this to Block Kit; we keep it simple.
      try {
        return { text: toPlainText(m.ast as FormattedContent) };
      } catch {
        return { text: '' };
      }
    }
  }
  // Card / CardElement: fall back to a placeholder. Real rendering would
  // require the cards.ts converter from @chat-adapter/slack.
  return { text: '[unsupported message type]' };
}

/**
 * Convert a Slack event payload into a chat-sdk `Message`.
 *
 * The official adapter does considerable mrkdwn → mdast conversion; we keep
 * it minimal (plain text only) since kuma-lite only needs to read slash
 * command text, not interpret rich formatting.
 */
function rawToMessage(
  raw: SlackRawMessage,
  fallback: { threadId: string; botUserId?: string; userName?: string },
): Message<SlackRawMessage> {
  const id = (raw.ts as string | undefined) ?? (raw.client_msg_id as string | undefined) ?? '';
  const text = (raw.text as string | undefined) ?? '';
  const userId = (raw.user as string | undefined) ?? (raw.bot_id as string | undefined) ?? '';
  const author: Author = {
    fullName: userId,
    isBot: raw.bot_id ? true : 'unknown',
    isMe: Boolean(fallback.botUserId && userId === fallback.botUserId),
    userId,
    userName: userId,
  };
  const dateMs = Number.parseFloat((raw.ts as string | undefined) ?? '0') * 1000;
  const data: MessageData<SlackRawMessage> = {
    id,
    threadId: fallback.threadId,
    text,
    formatted: rootText(text),
    raw,
    author,
    metadata: {
      dateSent: Number.isFinite(dateMs) && dateMs > 0 ? new Date(dateMs) : new Date(),
      edited: Boolean(raw.edited),
    },
    attachments: [],
    links: [],
  };
  return new Message<SlackRawMessage>(data);
}

export class SlackWorkersAdapter implements Adapter<SlackThreadId, SlackRawMessage> {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  botUserId?: string;

  private readonly client: SlackClient;
  private readonly signingSecret?: string;
  private chat?: ChatInstance;
  private logger: Logger | undefined;

  constructor(config: SlackAdapterConfig) {
    this.userName = config.userName ?? 'bot';
    this.botUserId = config.botUserId;
    this.signingSecret = config.signingSecret;
    this.logger = config.logger;
    this.client = new SlackClient({
      token: config.botToken,
      apiUrl: config.apiUrl,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = this.logger ?? chat.getLogger('slack');
    if (!this.botUserId) {
      try {
        const auth = (await this.client.authTest()) as { user_id?: string; user?: string };
        this.botUserId = auth.user_id;
      } catch (err) {
        this.logger?.warn('auth.test failed during initialize', err);
      }
    }
  }

  // ── Thread id helpers ───────────────────────────────────────────────────

  channelIdFromThreadId(threadId: string): string {
    const { channel } = decodeSlackThreadId(threadId);
    return `slack:${channel}`;
  }

  encodeThreadId(data: SlackThreadId): string {
    return encodeSlackThreadId(data);
  }

  decodeThreadId(threadId: string): SlackThreadId {
    return decodeSlackThreadId(threadId);
  }

  // ── Webhook entry point ─────────────────────────────────────────────────

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (!this.signingSecret) {
      return jsonResponse(
        { error: 'signing_secret_not_configured' },
        500,
      );
    }

    const rawBody = await request.text();
    const verification = await verifySlackRequest({
      signingSecret: this.signingSecret,
      signatureHeader: request.headers.get('x-slack-signature'),
      timestampHeader: request.headers.get('x-slack-request-timestamp'),
      rawBody,
    });
    if (!verification.ok) {
      this.logger?.warn(`slack webhook rejected: ${verification.reason}`);
      return new Response('invalid_signature', { status: 401 });
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return this.handleJsonWebhook(rawBody, options);
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return this.handleFormWebhook(rawBody, options);
    }
    return new Response('unsupported_content_type', { status: 415 });
  }

  private async handleJsonWebhook(
    rawBody: string,
    options: WebhookOptions | undefined,
  ): Promise<Response> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return new Response('bad_json', { status: 400 });
    }

    if (payload.type === 'url_verification') {
      return jsonResponse({ challenge: payload.challenge });
    }

    if (payload.type === 'event_callback') {
      const event = payload.event as Record<string, unknown> | undefined;
      if (event && this.chat) {
        await this.dispatchEvent(event, options);
      }
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: true });
  }

  private async handleFormWebhook(
    rawBody: string,
    options: WebhookOptions | undefined,
  ): Promise<Response> {
    const params = new URLSearchParams(rawBody);
    const command = params.get('command');
    if (command) {
      return this.dispatchSlashCommand(params, options);
    }
    const payloadField = params.get('payload');
    if (payloadField) {
      // Interactive components / shortcuts. Not required for kuma-lite.
      return jsonResponse({ ok: true });
    }
    return new Response('unrecognized_form_payload', { status: 400 });
  }

  private async dispatchSlashCommand(
    params: URLSearchParams,
    options: WebhookOptions | undefined,
  ): Promise<Response> {
    const chat = this.chat;
    if (!chat) {
      return jsonResponse({ ok: true });
    }
    const channel = params.get('channel_id') ?? '';
    const userId = params.get('user_id') ?? '';
    const command = params.get('command') ?? '';
    const text = params.get('text') ?? '';
    const triggerId = params.get('trigger_id') ?? undefined;
    const responseUrl = params.get('response_url') ?? undefined;

    const channelId = `slack:${channel}`;
    const author: Author = {
      fullName: params.get('user_name') ?? userId,
      isBot: false,
      isMe: false,
      userId,
      userName: params.get('user_name') ?? userId,
    };
    const raw = Object.fromEntries(params.entries());

    chat.processSlashCommand(
      {
        adapter: this as unknown as Adapter,
        channelId,
        command,
        text,
        triggerId,
        user: author,
        raw,
      },
      options,
    );

    // Acknowledge with an empty 200. Returning a JSON body with an empty
    // `text` field surfaces as "invalid_command_response" in Slack — the
    // platform expects either a populated payload or an empty body for
    // deferred handling. The async handler posts back via channel.post(),
    // which routes through `postChannelMessage`.
    void responseUrl;
    return new Response('', { status: 200 });
  }

  private async dispatchEvent(
    event: Record<string, unknown>,
    options: WebhookOptions | undefined,
  ): Promise<void> {
    const chat = this.chat;
    if (!chat) return;

    const type = event.type as string | undefined;
    if (type === 'message' || type === 'app_mention') {
      const channel = (event.channel as string | undefined) ?? '';
      const ts = (event.ts as string | undefined) ?? '';
      const threadTs = (event.thread_ts as string | undefined) ?? ts;
      const threadId = encodeSlackThreadId({ channel, threadTs });
      chat.processMessage(this as unknown as Adapter, threadId, () =>
        Promise.resolve(
          rawToMessage(event as SlackRawMessage, {
            threadId,
            botUserId: this.botUserId,
            userName: this.userName,
          }),
        ),
      );
    }
  }

  // ── Outbound messages ───────────────────────────────────────────────────

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<SlackRawMessage>> {
    const { channel, threadTs } = decodeSlackThreadId(threadId);
    const { text, blocks } = postableToText(message);
    const args: Parameters<SlackClient['postMessage']>[0] = {
      channel,
      text,
      // thread_ts only when it differs from the canonical channel-top thread.
      // We always send it: posting with thread_ts = ts of an existing top-level
      // message replies in-thread, while sending without thread_ts would post
      // a new top-level message.
      thread_ts: threadTs || undefined,
      // Bots posting alerts/status almost never want Slack to expand link
      // previews — they crowd the channel with unrelated thumbnails. Default
      // off; future config can re-enable per-message if needed.
      unfurl_links: false,
      unfurl_media: false,
    };
    if (blocks) args.blocks = blocks;
    const result = await this.client.postMessage(args);
    return {
      id: result.ts,
      threadId: encodeSlackThreadId({ channel, threadTs: result.ts }),
      raw: (result.message as SlackRawMessage | undefined) ?? (result as SlackRawMessage),
    };
  }

  /**
   * Post a top-level message to a channel (no thread).
   *
   * `chat-sdk`'s `Channel.post(...)` routes through this method when the
   * adapter implements it; without it the framework falls back to errors.
   * We strip the `slack:` prefix that chat-sdk uses to namespace channel
   * ids across adapters.
   */
  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<SlackRawMessage>> {
    const channel = channelId.startsWith('slack:')
      ? channelId.slice('slack:'.length)
      : channelId;
    const { text, blocks } = postableToText(message);
    const args: Parameters<SlackClient['postMessage']>[0] = {
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    };
    if (blocks) args.blocks = blocks;
    const result = await this.client.postMessage(args);
    return {
      id: result.ts,
      threadId: encodeSlackThreadId({ channel, threadTs: result.ts }),
      raw: (result.message as SlackRawMessage | undefined) ?? (result as SlackRawMessage),
    };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<SlackRawMessage>> {
    const { channel } = decodeSlackThreadId(threadId);
    const { text, blocks } = postableToText(message);
    const args: { channel: string; ts: string; text?: string; blocks?: unknown[] } = {
      channel,
      ts: messageId,
      text,
    };
    if (blocks) args.blocks = blocks;
    const result = await this.client.updateMessage(args);
    return { id: result.ts, threadId, raw: result as SlackRawMessage };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { channel } = decodeSlackThreadId(threadId);
    await this.client.deleteMessage({ channel, ts: messageId });
  }

  // ── Reactions ───────────────────────────────────────────────────────────

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const { channel } = decodeSlackThreadId(threadId);
    await this.client.addReaction({
      channel,
      timestamp: messageId,
      name: emoji.replace(/:/g, ''),
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const { channel } = decodeSlackThreadId(threadId);
    await this.client.removeReaction({
      channel,
      timestamp: messageId,
      name: emoji.replace(/:/g, ''),
    });
  }

  // ── Reads (minimal) ─────────────────────────────────────────────────────

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<SlackRawMessage>> {
    const { channel, threadTs } = decodeSlackThreadId(threadId);
    if (!threadTs) return { messages: [] };
    const limit = options?.limit ?? 50;
    const reqArgs: Parameters<SlackClient['conversationsReplies']>[0] = {
      channel,
      ts: threadTs,
      limit,
    };
    if (options?.cursor) reqArgs.cursor = options.cursor;
    const result = await this.client.conversationsReplies(reqArgs);
    const messages = result.messages.map((m) =>
      rawToMessage(m as SlackRawMessage, {
        threadId,
        botUserId: this.botUserId,
        userName: this.userName,
      }),
    );
    const nextCursor = result.response_metadata?.next_cursor;
    return nextCursor ? { messages, nextCursor } : { messages };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { channel } = decodeSlackThreadId(threadId);
    return {
      id: threadId,
      channelId: `slack:${channel}`,
      metadata: {},
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const channel = channelId.startsWith('slack:')
      ? channelId.slice('slack:'.length)
      : channelId;
    try {
      const result = await this.client.conversationsInfo({ channel });
      const c = result.channel;
      return {
        id: channelId,
        name: (c.name as string | undefined) ?? channel,
        isDM: Boolean(c.is_im),
        memberCount: typeof c.num_members === 'number' ? (c.num_members as number) : undefined,
        metadata: c,
      };
    } catch {
      return { id: channelId, metadata: {} };
    }
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    try {
      const result = await this.client.usersInfo({ user: userId });
      const u = result.user as Record<string, unknown>;
      const profile = (u.profile as Record<string, unknown> | undefined) ?? {};
      return {
        userId,
        userName: (u.name as string | undefined) ?? userId,
        fullName:
          (profile.real_name as string | undefined) ??
          (u.real_name as string | undefined) ??
          userId,
        isBot: Boolean(u.is_bot),
        avatarUrl: profile.image_192 as string | undefined,
        email: profile.email as string | undefined,
      };
    } catch {
      return null;
    }
  }

  // ── Stubs ───────────────────────────────────────────────────────────────

  parseMessage(raw: SlackRawMessage): Message<SlackRawMessage> {
    const channel = (raw.channel as string | undefined) ?? '';
    const ts = (raw.ts as string | undefined) ?? '';
    const threadTs = (raw.thread_ts as string | undefined) ?? ts;
    const threadId = encodeSlackThreadId({ channel, threadTs });
    return rawToMessage(raw, {
      threadId,
      botUserId: this.botUserId,
      userName: this.userName,
    });
  }

  renderFormatted(content: FormattedContent): string {
    try {
      return toPlainText(content);
    } catch {
      return '';
    }
  }

  // Slack's API has no first-class typing indicator on Web API; the official
  // adapter posts an "assistant_thread::set_status". We no-op.
  async startTyping(_threadId: string, _status?: string): Promise<void> {
    void _threadId;
    void _status;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Re-exports referenced by `Author` typing above.
export type { Author };
