/*
 * Slack request signature verification, Web Crypto edition.
 *
 * Slack signs each incoming request with HMAC-SHA256 over
 *   `v0:{timestamp}:{rawBody}`
 * keyed by the app's signing secret. The hex digest is sent as
 * `X-Slack-Signature: v0={hex}` and the timestamp as `X-Slack-Request-Timestamp`.
 *
 * Reference: https://api.slack.com/authentication/verifying-requests-from-slack
 */

const TIMESTAMP_TOLERANCE_SECONDS = 60 * 5;

function hexEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export interface VerifySlackRequestInput {
  signingSecret: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string | Uint8Array;
  /** Override Date.now() for testing. */
  nowSeconds?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

/** Reject unauthenticated metadata before allocating or waiting for a body. */
export function verifySlackRequestMetadata(
  signatureHeader: string | null, timestampHeader: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!signatureHeader || !timestampHeader) return { ok: false, reason: 'missing_headers' };
  if (!/^v0=[0-9a-f]{64}$/.test(signatureHeader)) return { ok: false, reason: 'bad_signature' };
  if (!/^[0-9]{1,12}$/.test(timestampHeader)) return { ok: false, reason: 'stale_timestamp' };
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  return { ok: true };
}

export async function verifySlackRequest(
  input: VerifySlackRequestInput,
): Promise<VerifyResult> {
  const { signingSecret, signatureHeader, timestampHeader, rawBody } = input;
  const metadata = verifySlackRequestMetadata(signatureHeader, timestampHeader, input.nowSeconds);
  if (!metadata.ok) return metadata;

  const key = await importHmacKey(signingSecret);
  // HMAC must cover the exact received bytes, before any JSON/form decoding.
  const prefix = new TextEncoder().encode(`v0:${timestampHeader}:`);
  const body = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
  const signedBytes = new Uint8Array(prefix.byteLength + body.byteLength);
  signedBytes.set(prefix); signedBytes.set(body, prefix.byteLength);
  const sigBytes = await crypto.subtle.sign('HMAC', key, signedBytes);
  const expected = `v0=${hexEncode(sigBytes)}`;

  return timingSafeEqualHex(expected, signatureHeader!)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

export const MAX_SLACK_WEBHOOK_BYTES = 256 * 1024;
export const SLACK_WEBHOOK_READ_TIMEOUT_MS = 3000;
type AdmissionOptions = { maxBytes?: number; timeoutMs?: number; nowSeconds?: number };
type SlackAdmission = { ok: true; request: Request; rawBody: string } | { ok: false; response: Response };
const admitted = new WeakMap<Request, { secret: string; signature: string; timestamp: string; rawBody: string }>();

/**
 * The SDK initializes adapters before dispatch. Authenticate a bounded body at
 * the Worker boundary first, and let the adapter reuse this private admission
 * result instead of reading/decoding the body a second time. Direct adapter
 * users pass through the same checks. No request-controlled admission marker is
 * accepted, and cached requests still have their timestamp checked on reuse.
 */
export async function admitSlackWebhook(request: Request, secret: string, options: AdmissionOptions = {}): Promise<SlackAdmission> {
  const reject = (status: number, text: string): SlackAdmission => {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
    return { ok: false, response: new Response(text, { status,
      headers: { 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'POST' } : {}) } }) };
  };
  if (request.method !== 'POST') return reject(405, 'method_not_allowed');
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  if (!verifySlackRequestMetadata(signature, timestamp, options.nowSeconds).ok) return reject(401, 'invalid_signature');
  const held = admitted.get(request);
  if (held && held.secret === secret && held.signature === signature && held.timestamp === timestamp) {
    return { ok: true, request, rawBody: held.rawBody };
  }
  if (request.signal.aborted) return reject(400, 'request_aborted');
  const maxBytes = options.maxBytes ?? MAX_SLACK_WEBHOOK_BYTES;
  const timeoutMs = options.timeoutMs ?? SLACK_WEBHOOK_READ_TIMEOUT_MS;
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d{1,12}$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    return reject(413, 'body_too_large');
  }
  const reader = request.body?.getReader();
  // A byte cap must also bound allocation when a sender produces many empty or
  // one-byte chunks. Retain one buffer, never a per-chunk list or deadline race.
  const buffer = new Uint8Array(maxBytes);
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let failure = 'body_read_failed';
  const stop = () => { if (reader) void reader.cancel().catch(() => undefined); };
  try {
    const expiresAt = performance.now() + timeoutMs;
    const deadline = new Promise<never>((_, fail) => {
      timer = setTimeout(() => { failure = 'body_read_timeout'; stop(); fail(new Error(failure)); }, timeoutMs);
      abort = () => { failure = 'request_aborted'; stop(); fail(new Error(failure)); };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    });
    const consumeAndVerify = async (): Promise<SlackAdmission> => {
      const checkDeadline = () => {
        if (request.signal.aborted || failure === 'body_read_timeout' || performance.now() >= expiresAt) {
          failure = request.signal.aborted ? 'request_aborted' : 'body_read_timeout'; throw new Error(failure);
        }
      };
      if (reader) for (;;) {
        checkDeadline();
        const next = await reader.read();
        // Empty chunks can starve the timer's task; use a monotonic check too.
        checkDeadline();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new Error('invalid_body_chunk');
        if (next.value.byteLength > maxBytes - total) { failure = 'body_too_large'; throw new Error(failure); }
        buffer.set(next.value, total);
        total += next.value.byteLength;
      }
      const bytes = buffer.subarray(0, total);
      const verification = await verifySlackRequest({ signingSecret: secret, signatureHeader: signature,
        timestampHeader: timestamp, rawBody: bytes, nowSeconds: options.nowSeconds });
      checkDeadline();
      if (!verification.ok) return reject(401, 'invalid_signature');
      let rawBody: string;
      try { rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
      catch { return reject(400, 'invalid_body_encoding'); }
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      const prepared = new Request(request.url, { method: 'POST', headers, body: bytes, signal: request.signal });
      admitted.set(prepared, { secret, signature: signature!, timestamp: timestamp!, rawBody });
      return { ok: true, request: prepared, rawBody };
    };
    // One registration bounds deadline reactions regardless of chunk count.
    return await Promise.race([consumeAndVerify(), deadline]);
  } catch {
    stop();
    return reject(failure === 'body_too_large' ? 413 : failure === 'body_read_timeout' ? 408 : 400, failure);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) request.signal.removeEventListener('abort', abort);
    // A sender/cancel implementation may still have a pending read. Cleanup
    // must not replace the bounded 400/408/413 result with a stream exception.
    try { reader?.releaseLock(); } catch { /* best-effort release after cancellation */ }
  }
}
