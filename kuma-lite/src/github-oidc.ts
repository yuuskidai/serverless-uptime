const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 65_536;
const CACHE_MS = 600_000;
const REFRESH_FLOOR_MS = 30_000;

export interface GithubOidcConfig {
  audience: string;
  repository: string;
  repositoryId: string;
  ownerId: string;
  workflowRef: string;
}

export interface GithubOidcClaims {
  iss: string;
  aud: string;
  sub: string;
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  ref: string;
  workflow_ref: string;
  event_name: 'schedule' | 'push' | 'workflow_dispatch';
  run_id: string;
  run_attempt: string;
  iat: number;
  nbf: number;
  exp: number;
  sha?: string;
}

export interface GithubOidcOptions {
  fetcher?: typeof fetch;
  /** Milliseconds since epoch. Production uses Date.now(). */
  now?: number;
  /** Test injection may shorten, never extend, the five-second network budget. */
  fetchTimeoutMs?: number;
}

export class GithubOidcError extends Error {
  readonly kind: 'invalid' | 'unavailable';
  readonly retryable: boolean;

  constructor(kind: 'invalid' | 'unavailable') {
    super(kind === 'invalid' ? 'GitHub identity is invalid' : 'GitHub identity verification is unavailable');
    this.name = 'GithubOidcError';
    this.kind = kind;
    this.retryable = kind === 'unavailable';
  }
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
  lastAttemptAt: number;
  pending: Promise<void> | null;
}

// The production fetch function has one cache per isolate. Injected test fetchers
// receive separate caches, so fake keys never contaminate production verification.
const caches = new WeakMap<typeof fetch, KeyCache>();
const invalid = (): never => { throw new GithubOidcError('invalid'); };
const unavailable = (): never => { throw new GithubOidcError('unavailable'); };

function base64url(value: string, max: number): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return invalid();
  let bytes: Uint8Array;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    if (binary.length > max) return invalid();
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const canonical = btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (canonical !== value) return invalid();
  } catch { return invalid(); }
  return bytes;
}

function objectJson(value: Uint8Array): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
    return parsed as Record<string, unknown>;
  } catch { return invalid(); }
}

function validateConfig(config: GithubOidcConfig): void {
  if (!config || typeof config.audience !== 'string' || config.audience.length > 2048 ||
      typeof config.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
      typeof config.repositoryId !== 'string' || !/^[1-9]\d{0,19}$/.test(config.repositoryId) ||
      typeof config.ownerId !== 'string' || !/^[1-9]\d{0,19}$/.test(config.ownerId) ||
      typeof config.workflowRef !== 'string' ||
      !config.workflowRef.startsWith(`${config.repository}/.github/workflows/`) ||
      !config.workflowRef.endsWith('@refs/heads/master')) return unavailable();
  try {
    const audience = new URL(config.audience);
    if (audience.protocol !== 'https:' || audience.username || audience.password || audience.search || audience.hash) return unavailable();
  } catch { return unavailable(); }
}

function validateClaims(value: Record<string, unknown>, config: GithubOidcConfig, now: number): GithubOidcClaims {
  const ref = 'refs/heads/master';
  const [owner, repository] = config.repository.split('/');
  // Both GitHub-documented formats bind the same strictly checked numeric IDs.
  // https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims
  const subjects = [`repo:${config.repository}:ref:${ref}`,
    `repo:${owner}@${config.ownerId}/${repository}@${config.repositoryId}:ref:${ref}`];
  if (value.iss !== ISSUER || value.aud !== config.audience || value.repository !== config.repository ||
      value.repository_id !== config.repositoryId || value.repository_owner_id !== config.ownerId ||
      value.ref !== ref || value.workflow_ref !== config.workflowRef ||
      typeof value.sub !== 'string' || !subjects.includes(value.sub) ||
      typeof value.event_name !== 'string' || !['schedule', 'push', 'workflow_dispatch'].includes(value.event_name) ||
      typeof value.run_id !== 'string' || !/^[1-9]\d{0,19}$/.test(value.run_id) ||
      typeof value.run_attempt !== 'string' || !/^[1-9]\d{0,5}$/.test(value.run_attempt)) return invalid();
  const { iat, nbf, exp } = value;
  if (typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number' ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) ||
      iat <= 0 || nbf <= 0 || exp <= 0 ||
      // GitHub's documented token backdates nbf by ten minutes. The issued-at
      // age, expiry and signature still independently bound token acceptance.
      // https://docs.github.com/en/actions/concepts/security/openid-connect
      iat > now + 30 || iat < now - 600 || nbf > now + 30 || nbf < iat - 600 || nbf > iat + 30 ||
      exp <= now || exp <= iat || exp <= nbf || exp - iat > 900) return invalid();
  if (value.sha !== undefined && (typeof value.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.sha))) return invalid();
  return {
    iss: ISSUER, aud: config.audience, sub: value.sub as string,
    repository: config.repository, repository_id: config.repositoryId,
    repository_owner_id: config.ownerId, ref, workflow_ref: config.workflowRef,
    event_name: value.event_name as GithubOidcClaims['event_name'],
    run_id: value.run_id, run_attempt: value.run_attempt, iat, nbf, exp,
    ...(value.sha !== undefined ? { sha: (value.sha as string).toLowerCase() } : {}),
  };
}

async function readJwks(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) return unavailable();
  const declaredSize = response.headers.get('content-length');
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_JWKS_BYTES)) return unavailable();
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_JWKS_BYTES) { cancel(); return unavailable(); }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { return unavailable(); }
}

async function importJwks(value: unknown): Promise<Map<string, CryptoKey>> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { keys?: unknown }).keys)) return unavailable();
  const candidates = (value as { keys: unknown[] }).keys;
  if (candidates.length < 1 || candidates.length > 32) return unavailable();
  const keys = new Map<string, CryptoKey>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return unavailable();
    const key = candidate as Record<string, unknown>;
    if (key.kty !== 'RSA' || (key.use !== undefined && key.use !== 'sig') ||
        (key.alg !== undefined && key.alg !== 'RS256') || typeof key.kid !== 'string' ||
        !/^[A-Za-z0-9._-]{1,256}$/.test(key.kid) || typeof key.n !== 'string' || typeof key.e !== 'string' ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(field => key[field] !== undefined) || keys.has(key.kid)) return unavailable();
    let modulus: Uint8Array, exponent: Uint8Array;
    try { modulus = base64url(key.n, 1024); exponent = base64url(key.e, 4); }
    catch { return unavailable(); }
    if (modulus.length < 256 || modulus[0] < 128 || exponent.length === 0 || exponent.length > 4) return unavailable();
    let exponentNumber = 0;
    for (const byte of exponent) exponentNumber = exponentNumber * 256 + byte;
    if (exponentNumber < 3 || exponentNumber % 2 !== 1) return unavailable();
    try {
      const imported = await crypto.subtle.importKey('jwk', {
        kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true, key_ops: ['verify'],
      }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      keys.set(key.kid, imported);
    } catch { return unavailable(); }
  }
  return keys;
}

async function refreshKeys(state: KeyCache, fetcher: typeof fetch, nowMs: number, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  const operation = (async () => {
    response = await fetcher(JWKS_URL, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json' } });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      return unavailable();
    }
    const keys = await importJwks(await readJwks(response, controller.signal));
    controller.signal.throwIfAborted();
    state.keys = keys;
    state.expiresAt = nowMs + CACHE_MS;
  })();
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new GithubOidcError('unavailable')); }, timeoutMs);
    })]);
  } catch { return unavailable(); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

async function signingKey(kid: string, fetcher: typeof fetch, nowMs: number, timeoutMs: number): Promise<CryptoKey> {
  let state = caches.get(fetcher);
  if (!state) {
    state = { keys: new Map(), expiresAt: 0, lastAttemptAt: -Infinity, pending: null };
    caches.set(fetcher, state);
  }
  if (nowMs < state.expiresAt && state.keys.has(kid)) return state.keys.get(kid)!;
  if (!state.pending && nowMs - state.lastAttemptAt >= REFRESH_FLOOR_MS) {
    state.lastAttemptAt = nowMs;
    const current = state;
    state.pending = refreshKeys(state, fetcher, nowMs, timeoutMs).finally(() => { current.pending = null; });
  }
  if (state.pending) await state.pending;
  if (nowMs < state.expiresAt && state.keys.has(kid)) return state.keys.get(kid)!;
  if (state.expiresAt <= nowMs) return unavailable();
  return invalid();
}

/** Verify only GitHub's fixed issuer keys and the configured repository/workflow identity. */
export async function verifyGithubOidc(token: string, config: GithubOidcConfig,
  options: GithubOidcOptions = {}): Promise<GithubOidcClaims> {
  validateConfig(config);
  const nowMs = options.now ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return unavailable();
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) return invalid();
  const segments = token.split('.');
  if (segments.length !== 3) return invalid();
  const header = objectJson(base64url(segments[0], 4096));
  if (header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT') ||
      typeof header.kid !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(header.kid) ||
      ['crit', 'jku', 'x5u', 'jwk'].some(key => header[key] !== undefined)) return invalid();
  const claims = validateClaims(objectJson(base64url(segments[1], 8192)), config, Math.floor(nowMs / 1000));
  const signature = base64url(segments[2], 1024);
  if (signature.byteLength < 256) return invalid();
  const timeoutMs = Math.max(1, Math.min(5000, options.fetchTimeoutMs ?? 5000));
  const key = await signingKey(header.kid, options.fetcher ?? fetch, nowMs, timeoutMs);
  let verified = false;
  try { verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature,
    new TextEncoder().encode(`${segments[0]}.${segments[1]}`)); }
  catch { return invalid(); }
  if (!verified) return invalid();
  return claims;
}
