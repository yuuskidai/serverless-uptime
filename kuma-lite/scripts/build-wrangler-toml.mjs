#!/usr/bin/env node
// Generate kuma-lite/wrangler.toml from wrangler.toml.example by
// substituting per-deploy values supplied via environment variables.
//
// Why this exists: wrangler.toml is gitignored on this fork so
// owner-specific Cloudflare ids (D1 database, service binding names)
// don't leak into the public history. Cloudflare Workers Builds
// can't deploy without a wrangler.toml in the cloned tree, so the
// build pipeline reconstitutes one from this script using env vars
// configured in the Workers Builds dashboard.
//
// Required env vars:
//   D1_DATABASE_ID   — uuid of the D1 database to bind as DB
//
// Optional env vars:
//   WRANGLER_SERVICES — comma-separated list of `BINDING=service`
//                       pairs declaring [[services]] blocks. Empty
//                       skips appending any service binding section.
//                       e.g. `MY_API=my-api,OTHER=other-worker`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(root, 'wrangler.toml.example');
const outPath = path.join(root, 'wrangler.toml');

const dbId = process.env.D1_DATABASE_ID;
if (!dbId) {
  console.error('build-wrangler-toml: D1_DATABASE_ID env var is required.');
  console.error('  Set it in Workers Builds → Settings → Build → Environment variables,');
  console.error('  or export it before running this script locally.');
  process.exit(1);
}

if (!fs.existsSync(examplePath)) {
  console.error(`build-wrangler-toml: missing template at ${examplePath}`);
  process.exit(1);
}

let content = fs.readFileSync(examplePath, 'utf8');

if (!content.includes('<your-d1-database-id>')) {
  console.error('build-wrangler-toml: template does not contain the expected database_id placeholder.');
  process.exit(1);
}
content = content.replace('<your-d1-database-id>', dbId);

const servicesEnv = (process.env.WRANGLER_SERVICES ?? '').trim();
if (servicesEnv) {
  const blocks = servicesEnv.split(',').map((pair) => {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new Error(
        `WRANGLER_SERVICES: invalid entry "${trimmed}", expected BINDING=service`,
      );
    }
    const binding = trimmed.slice(0, eq).trim();
    const service = trimmed.slice(eq + 1).trim();
    return `[[services]]\nbinding = "${binding}"\nservice = "${service}"`;
  });
  content = content.trimEnd() + '\n\n' + blocks.join('\n\n') + '\n';
}

fs.writeFileSync(outPath, content);
console.log(`build-wrangler-toml: wrote ${path.relative(process.cwd(), outPath)}`);
