import { KINDS, REASONS } from './types';
import type { AppEvent } from './types';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HASH = /^[0-9a-f]{64}$/;
export const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
export function appEvent(value: unknown, now: number): AppEvent | null {
  if (!object(value) || Object.keys(value).some(k => !['version','eventId','occurredAt','kind','reason','actorHash','networkHash','requestId'].includes(k))) return null;
  if (value.version !== 1 || typeof value.eventId !== 'string' || !UUID.test(value.eventId)
    || !Number.isSafeInteger(value.occurredAt) || (value.occurredAt as number) < now - 300_000 || (value.occurredAt as number) > now + 30_000
    || !KINDS.includes(value.kind as AppEvent['kind'])) return null;
  if (value.reason !== undefined && !REASONS.includes(value.reason as AppEvent['reason'] & string)) return null;
  for (const field of ['actorHash','networkHash']) if (value[field] !== undefined && (typeof value[field] !== 'string' || !HASH.test(value[field] as string))) return null;
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !UUID.test(value.requestId))) return null;
  // Reconstruct an allowlisted DTO: never retain arbitrary input/prototypes.
  return { version: 1, eventId: value.eventId, occurredAt: value.occurredAt as number, kind: value.kind as AppEvent['kind'],
    ...(value.reason !== undefined ? {reason: value.reason as AppEvent['reason']} : {}),
    ...(value.actorHash !== undefined ? {actorHash: value.actorHash as string} : {}),
    ...(value.networkHash !== undefined ? {networkHash: value.networkHash as string} : {}),
    ...(value.requestId !== undefined ? {requestId: value.requestId as string} : {}) };
}
export async function equalSecret(actual: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9_-]{43})$/.test(expected) || !actual || actual.length > 128) return false;
  const bytes = new TextEncoder();
  const [x,y] = await Promise.all([actual, expected].map(v => crypto.subtle.digest('SHA-256', bytes.encode(v))));
  const a = new Uint8Array(x), b = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export async function boundedJSON(request: Request | Response, max = 65536, timeoutMs = 2000): Promise<unknown> {
  const size = request.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > max)) throw new Error('invalid_body');
  if (!request.body) throw new Error('invalid_body');
  const reader = request.body.getReader(), end = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([ (async () => {
      let total = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const item = await reader.read();
        if (performance.now() >= end) throw new Error('timeout');
        if (item.done) break;
        total += item.value.byteLength; if (total > max) throw new Error('invalid_body'); chunks.push(item.value);
      }
      const all = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) {all.set(chunk, offset); offset += chunk.byteLength;}
      const result = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(all));
      if (performance.now() >= end) throw new Error('timeout');
      return result;
    })(), new Promise((_,reject) => {timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);}) ]);
  } finally { if (timer !== undefined) clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}
