import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Share the repository's pinned, npm-ci-installed toolchain. Never download tools.
const require = createRequire(new URL('../../kuma-lite/package.json', import.meta.url));
const [command, ...args] = process.argv.slice(2);
const typecheck = command === 'typecheck';
if (!['typecheck', 'dev', 'deploy'].includes(command)) throw new Error('Unknown tool command');
const binary = typecheck ? require.resolve('typescript/bin/tsc')
  : join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
// Select the single top-level Wrangler configuration explicitly while preserving
// the inherited authentication, proxy and runtime guard environment.
const result = spawnSync(process.execPath, [binary, ...(typecheck ? ['--noEmit', '-p', 'tsconfig.json'] : [command, '--env', '']), ...args], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', env: process.env,
});
process.exit(result.status ?? 1);
