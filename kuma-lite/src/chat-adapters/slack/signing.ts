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
  rawBody: string;
  /** Override Date.now() for testing. */
  nowSeconds?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

export async function verifySlackRequest(
  input: VerifySlackRequestInput,
): Promise<VerifyResult> {
  const { signingSecret, signatureHeader, timestampHeader, rawBody } = input;
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const key = await importHmacKey(signingSecret);
  const baseString = `v0:${timestamp}:${rawBody}`;
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  const expected = `v0=${hexEncode(sigBytes)}`;

  return timingSafeEqualHex(expected, signatureHeader)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
