/**
 * Helpers for turning the probe URL stored in `monitors.url` into
 * something a human visitor would actually want to click.
 *
 * The probe URL typically ends in `/healthz` — a machine-readable
 * JSON endpoint that returns no usable HTML for humans. Linking the
 * status-page card to that URL means a visitor who clicks the link
 * lands on a wall of `{"status":"ok",...}` text instead of the site
 * they expected to see. Strip the `/healthz` suffix here so the
 * link points to the site root, while keeping the original probe
 * URL untouched in the database (the cron tick still hits
 * `/healthz`).
 */

/** Shared presentation boundary: probe credentials never belong in public URLs. */
export function safePublicWebUrl(probeUrl: string, rootOnly = false): string | null {
  try {
    const u = new URL(probeUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // Query strings and fragments may carry probe/API tokens. This redacts only
    // presentation; the stored URL used by the actual probe remains untouched.
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    if (rootOnly || u.pathname === '/healthz' || u.pathname === '/healthz/') {
      u.pathname = '/';
    }
    const output = u.toString();
    return output.length <= 3000 ? output : null;
  } catch {
    return null;
  }
}

export function publicFacingUrl(probeUrl: string): string {
  return safePublicWebUrl(probeUrl) ?? '';
}

/** Exception/health text can repeat the probe URL even when its link is safe. */
export type PublicUrlContext = string | readonly (string | null | undefined)[];

export function redactPublicUrls(text: string, probeUrls?: PublicUrlContext): string {
  // A stored probe URL may contain raw spaces/quotes that terminate a generic
  // URL matcher. Replace its full reprint before tokenization or output escaping.
  // Longest first also protects fallback URLs whose prefix is the primary URL.
  const known = (typeof probeUrls === 'string' ? [probeUrls] : probeUrls ?? [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);
  const knownRedacted = known.reduce((value, url) => value.split(url).join(safePublicWebUrl(url) ?? '[URL removed]'), text);
  const withoutUserinfo = knownRedacted.replace(/\b(https?:\/\/)[^/?#<>"'`\r\n]*@/gi, '$1');
  return withoutUserinfo
    .replace(/https?%3a%2f%2f[^\s<>"'`]+/gi, value => {
      try { const safe = safePublicWebUrl(decodeURIComponent(value)); return safe ? encodeURIComponent(safe) : '[URL removed]'; }
      catch { return '[URL removed]'; }
    })
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, value => safePublicWebUrl(value) ?? '[URL removed]');
}

/**
 * Compact human-readable label (host + non-root path), derived from
 * the public-facing URL — used in Slack/Discord/UI surfaces where a
 * full `https://...` is more noise than information. Always uses
 * the post-strip variant so visitors don't see `/healthz` in the
 * displayed label either.
 */
export function publicFacingDisplay(probeUrl: string): string {
  try {
    const u = new URL(publicFacingUrl(probeUrl));
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return '';
  }
}
