# kuma-lite

A minimal Uptime Kuma–style monitoring service that runs entirely on Cloudflare's
serverless platform: **Workers + D1 + Cron Triggers**. No always-on container,
no separate database server — everything fits within the free tier for small
deployments.

## Features

- HTTP/HTTPS endpoint health checks (1-minute minimum interval)
- Status code, response-time, and keyword body checks
- Configurable timeout and per-monitor retry threshold (flapping suppression)
- Discord webhook notifications on `DOWN` and recovery
- Public status page with 24h uptime % and a 90-minute timeline
- Token-authenticated REST API for monitor CRUD
- Daily cleanup of old check rows (configurable retention)

## Architecture

```
            ┌──────────────────┐
  every     │  Cron Trigger    │
  minute ──▶│  scheduled()     │──▶ runChecks() ──┬─▶ fetch each monitor
            └──────────────────┘                  ├─▶ INSERT into checks
                                                  ├─▶ UPSERT monitor_state
            ┌──────────────────┐                  └─▶ Discord webhook on flip
  03:00 ──▶│  Cron Trigger    │──▶ cleanupOldChecks()  (DELETE old rows)
  UTC      └──────────────────┘

            ┌──────────────────┐
  HTTP    ──▶│  fetch()         │──▶ /            renderStatusPage()
                                 ├─▶ /api/monitors handleApiRequest()
                                 └─▶ /healthz     liveness probe
```

State lives in three D1 tables:

- `monitors` — monitor definitions
- `checks` — individual probe results (rolled off after `RETENTION_DAYS`)
- `monitor_state` — current up/down + consecutive failure counter +
  `down_since` for duration reporting

## Setup

### 1. Install and create the D1 database

```bash
cd kuma-lite
npm install
npx wrangler d1 create kuma-lite-db
```

Copy the printed `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "kuma-lite-db"
database_id = "<paste here>"
```

### 2. Apply the schema

```bash
npx wrangler d1 execute kuma-lite-db --file=./schema.sql --remote
```

For local development, swap `--remote` for `--local`.

### 3. Set secrets

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL   # Discord incoming webhook URL
npx wrangler secret put API_TOKEN             # any random string, used as Bearer token
```

Generate a token quickly with `openssl rand -hex 32`.

### 4. Deploy

```bash
npx wrangler deploy
```

The Worker will be reachable at `https://kuma-lite.<your-subdomain>.workers.dev`.
The cron triggers configured in `wrangler.toml` start firing automatically:

- `* * * * *` — every minute, run due checks
- `0 3 * * *` — daily at 03:00 UTC, prune `checks` older than `RETENTION_DAYS`

### 5. Add a monitor

```bash
curl -X POST https://kuma-lite.<subdomain>.workers.dev/api/monitors \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Example",
    "url": "https://example.com",
    "expected_status": 200,
    "keyword": null,
    "timeout_ms": 10000,
    "interval_minutes": 1,
    "retry_threshold": 2
  }'
```

Open `https://kuma-lite.<subdomain>.workers.dev/` to see the status page.

## API

All endpoints require `Authorization: Bearer $API_TOKEN`.

| Method | Path                  | Body                                | Description            |
| ------ | --------------------- | ----------------------------------- | ---------------------- |
| GET    | `/api/monitors`       | —                                   | List monitors          |
| POST   | `/api/monitors`       | monitor fields (see below)          | Create monitor         |
| GET    | `/api/monitors/:id`   | —                                   | Get one monitor        |
| PATCH  | `/api/monitors/:id`   | partial fields                      | Update monitor         |
| DELETE | `/api/monitors/:id`   | —                                   | Delete monitor + history |

Monitor fields:

| Field              | Type      | Default | Notes                              |
| ------------------ | --------- | ------- | ---------------------------------- |
| `name`             | string    | —       | required                           |
| `url`              | string    | —       | required, must be `http(s)://…`    |
| `method`           | string    | `GET`   |                                    |
| `expected_status`  | number    | `200`   |                                    |
| `keyword`          | string    | `null`  | substring required in response     |
| `timeout_ms`       | number    | `10000` | clamped to `[1000, 30000]`         |
| `interval_minutes` | number    | `1`     | clamped to `[1, 60]`               |
| `retry_threshold`  | number    | `2`     | failures before alerting           |
| `enabled`          | boolean   | `true`  |                                    |

## Local development

```bash
npx wrangler d1 execute kuma-lite-db --file=./schema.sql --local
npx wrangler dev

# Trigger the cron handler manually:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## Operating notes

- **Sub-request budget.** Each cron invocation makes one HTTP request per due
  monitor plus a few D1 calls. Workers free plan caps sub-requests at 50 per
  invocation; checks are batched in groups of 40 to stay safely under that.
  If you exceed ~40 monitors, upgrade to the paid plan ($5/mo, 1000 sub-requests)
  or split monitors across multiple Workers.
- **CPU time.** The default cron CPU limit is generous, but extremely large
  fleets may want to interleave a second cron at a different minute offset.
- **Retention.** Bumping `RETENTION_DAYS` in `wrangler.toml` keeps more
  history; D1 free tier (5 GB) can absorb several years of small deployments.
- **Hidden monitors.** Set `HIDDEN_MONITOR_IDS = "3,7"` in `[vars]` to omit
  internal monitors from the public status page (they'll still be checked).

## Verification with the Cloudflare MCP

Once deployed, you can poke at the live database and Worker directly from the
Claude Code session via the Cloudflare MCP server. Useful queries:

```sql
-- Most recent checks
SELECT m.name, c.status, c.status_code, c.latency_ms, c.error,
       datetime(c.ts/1000, 'unixepoch') AS at
  FROM checks c JOIN monitors m ON m.id = c.monitor_id
 ORDER BY c.ts DESC LIMIT 20;

-- Currently down monitors
SELECT m.name, ms.consecutive_failures,
       datetime(ms.down_since/1000, 'unixepoch') AS down_since
  FROM monitor_state ms JOIN monitors m ON m.id = ms.monitor_id
 WHERE ms.current_status = 'down';
```

Run them through `d1_database_query`. `workers_get_worker_code` lets you confirm
the deployed bundle matches what's in this directory.

## Limits / non-goals

- HTTP/HTTPS only (no TCP, ICMP, or DNS probes — Workers can't open raw sockets
  in this configuration).
- Minimum interval is 1 minute (Cron Triggers granularity).
- Status page is render-on-request HTML — no WebSocket live updates.
- No multi-tenant auth model; the API is gated by a single shared bearer token.
