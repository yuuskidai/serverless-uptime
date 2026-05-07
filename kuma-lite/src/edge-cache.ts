/**
 * Edge-cache wrapper for public, read-only HTML/XML routes.
 *
 * On `*.workers.dev`, the Worker is invoked on every visitor request —
 * the `Cache-Control` headers our renderers already emit only steer
 * browser-side caches, not Cloudflare's edge. To offload duplicate D1
 * reads when `/status` (etc.) is fetched repeatedly inside its
 * freshness window, we have to talk to `caches.default` ourselves:
 * `match()` first, and on miss `put()` via `ctx.waitUntil` so the
 * cache write doesn't block the response.
 *
 * Cache TTL is driven by the response's own `Cache-Control: max-age=N`,
 * so each renderer keeps ownership of its freshness budget
 * (15s for status & incident pages, 300s for RSS). We never override
 * the header here.
 *
 * The same pattern works unchanged once this Worker is attached to a
 * custom domain — it just sits "above" the zone cache rather than
 * being the only cache layer in front of the Worker.
 */
export async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  produce: () => Promise<Response>,
): Promise<Response> {
  // The Cache API only stores GET/HEAD; skip the lookup for anything else
  // so callers can pass any request through this helper safely.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return produce();
  }

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) {
    return annotate(hit, 'HIT');
  }

  const fresh = await produce();

  // Only cache plain 200s. Errors, redirects, and the schema-gate 503
  // must not be pinned at the edge — transient problems should self-heal
  // on the next request, not stay served for `max-age` seconds.
  if (fresh.status !== 200) return fresh;

  // Respect upstream cacheability. The schema-gate 503 already short-
  // circuits above, but a future renderer could legitimately mark its
  // output as `no-store` / `private` and we shouldn't override that.
  const cc = fresh.headers.get('Cache-Control') ?? '';
  if (!cc || /no-store|private/i.test(cc)) {
    return fresh;
  }

  const annotated = annotate(fresh, 'MISS');
  // `cache.put` consumes the response body; clone first so the half we
  // return to the visitor is independent of the half being persisted.
  ctx.waitUntil(cache.put(request, annotated.clone()));
  return annotated;
}

/**
 * Stamp a debug header so HIT/MISS is visible in the browser network tab
 * without needing to enable Workers Logs sampling on these routes.
 */
function annotate(response: Response, state: 'HIT' | 'MISS'): Response {
  const headers = new Headers(response.headers);
  headers.set('CF-Worker-Cache', state);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
