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

export function publicFacingUrl(probeUrl: string): string {
  try {
    const u = new URL(probeUrl);
    if (u.pathname === '/healthz' || u.pathname === '/healthz/') {
      u.pathname = '/';
    }
    return u.toString();
  } catch {
    return probeUrl;
  }
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
    return probeUrl;
  }
}
