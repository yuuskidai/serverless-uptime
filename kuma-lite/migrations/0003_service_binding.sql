-- 0003_service_binding.sql
--
-- Adds the optional `service_binding` column on `monitors` so a row
-- can route its probe through a wrangler-declared service binding
-- (e.g. PARTNER_PORTAL) instead of a public HTTP fetch. Required for
-- monitored Workers that share the same Cloudflare account as
-- kuma-lite — bare fetch() to a same-zone *.workers.dev URL is
-- rejected with `error code: 1042` (same-zone recursion guard), and
-- service bindings are the documented escape hatch.
--
-- Run once against the remote DB:
--
--   wrangler d1 execute kuma-lite-db --file=./migrations/0003_service_binding.sql --remote
--
-- Idempotent: not natively, but ALTER TABLE ADD COLUMN IF NOT EXISTS
-- isn't supported on D1, so re-running on an already-migrated DB
-- will error harmlessly.

ALTER TABLE monitors ADD COLUMN service_binding TEXT;
