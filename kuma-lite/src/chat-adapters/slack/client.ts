/*
 * Minimal fetch-based Slack Web API client.
 *
 * This replaces `@slack/web-api` (which depends on axios and is therefore
 * incompatible with Cloudflare Workers) for the subset of Slack methods
 * the kuma-lite chat-sdk adapter actually invokes.
 *
 * Slack's Web API is uniform: every method accepts `POST` to
 * `https://slack.com/api/{method}` with `Authorization: Bearer {token}` and
 * a JSON body, and returns JSON with an `ok: boolean` field. Errors live in
 * the `error` field when `ok === false`. Rate limits surface as HTTP 429
 * with a `Retry-After` header.
 *
 * Reference: https://docs.slack.dev/reference/methods/
 */

import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ValidationError,
} from './errors';

const ADAPTER = 'slack';
const DEFAULT_API_URL = 'https://slack.com/api/';
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
]);

export interface SlackClientOptions {
  token: string;
  /** Override the API base URL (e.g. for GovSlack). Must end in `/`. */
  apiUrl?: string;
  /** Custom fetch implementation, mainly for testing. */
  fetchImpl?: typeof fetch;
}

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: {
    next_cursor?: string;
    messages?: string[];
    warnings?: string[];
  };
  [key: string]: unknown;
}

export class SlackClient {
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackClientOptions) {
    if (!options.token) {
      throw new ValidationError(ADAPTER, 'SlackClient requires a bot token');
    }
    this.token = options.token;
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * Invoke a Slack Web API method by name.
   *
   * Pass per-call overrides under reserved keys:
   *   `__token`: use a different bot token for this call (multi-workspace)
   */
  async call<T extends SlackApiResponse = SlackApiResponse>(
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const { __token, ...body } = args as { __token?: string } & Record<string, unknown>;
    const token = __token ?? this.token;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${method}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new NetworkError(
        ADAPTER,
        `fetch to ${method} failed`,
        cause instanceof Error ? cause : undefined,
      );
    }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
      throw new AdapterRateLimitError(
        ADAPTER,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }

    if (!response.ok) {
      throw new NetworkError(
        ADAPTER,
        `${method} returned HTTP ${response.status}`,
      );
    }

    let payload: T;
    try {
      payload = (await response.json()) as T;
    } catch (cause) {
      throw new NetworkError(
        ADAPTER,
        `${method} returned non-JSON response`,
        cause instanceof Error ? cause : undefined,
      );
    }

    if (!payload.ok) {
      const code = payload.error ?? 'unknown_error';
      if (AUTH_ERRORS.has(code)) {
        throw new AuthenticationError(ADAPTER, `${method}: ${code}`);
      }
      if (code === 'ratelimited') {
        throw new AdapterRateLimitError(ADAPTER);
      }
      throw new ValidationError(ADAPTER, `${method}: ${code}`);
    }

    return payload;
  }

  // Typed wrappers for the methods used by the adapter. These are thin
  // conveniences over `call()` and intentionally use loose typing to avoid
  // pulling in the full @slack/types surface.

  authTest() {
    return this.call('auth.test');
  }

  postMessage(args: {
    channel: string;
    text?: string;
    thread_ts?: string;
    blocks?: unknown[];
    attachments?: unknown[];
    metadata?: unknown;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
  }) {
    return this.call<SlackApiResponse & { ts: string; channel: string; message?: unknown }>(
      'chat.postMessage',
      args as Record<string, unknown>,
    );
  }

  updateMessage(args: { channel: string; ts: string; text?: string; blocks?: unknown[] }) {
    return this.call<SlackApiResponse & { ts: string; channel: string }>(
      'chat.update',
      args as Record<string, unknown>,
    );
  }

  deleteMessage(args: { channel: string; ts: string }) {
    return this.call<SlackApiResponse & { ts: string; channel: string }>(
      'chat.delete',
      args as Record<string, unknown>,
    );
  }

  addReaction(args: { channel: string; timestamp: string; name: string }) {
    return this.call('reactions.add', args as Record<string, unknown>);
  }

  removeReaction(args: { channel: string; timestamp: string; name: string }) {
    return this.call('reactions.remove', args as Record<string, unknown>);
  }

  conversationsReplies(args: {
    channel: string;
    ts: string;
    limit?: number;
    cursor?: string;
    oldest?: string;
    latest?: string;
  }) {
    return this.call<
      SlackApiResponse & { messages: Array<Record<string, unknown>>; has_more?: boolean }
    >('conversations.replies', args as Record<string, unknown>);
  }

  conversationsInfo(args: { channel: string }) {
    return this.call<SlackApiResponse & { channel: Record<string, unknown> }>(
      'conversations.info',
      args as Record<string, unknown>,
    );
  }

  conversationsOpen(args: { users: string }) {
    return this.call<SlackApiResponse & { channel: { id: string } }>(
      'conversations.open',
      args as Record<string, unknown>,
    );
  }

  usersInfo(args: { user: string }) {
    return this.call<SlackApiResponse & { user: Record<string, unknown> }>(
      'users.info',
      args as Record<string, unknown>,
    );
  }
}

/**
 * Slack provides each interactive payload with a `response_url`. POSTing to
 * that URL within 30 minutes (and 5 follow-ups) lets us reply to a slash
 * command outside the initial 3-second ack window.
 */
export async function postToResponseUrl(
  responseUrl: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<void> {
  const response = await fetchImpl(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new NetworkError(
      ADAPTER,
      `response_url POST failed with HTTP ${response.status}`,
    );
  }
}
