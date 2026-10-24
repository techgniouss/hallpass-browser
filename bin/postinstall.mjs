#!/usr/bin/env node
// npm postinstall: fetch Chrome for agent-browser right away so the first `hallpass open` is instant.
// Best effort by design: this must never make `npm i -g hallpass-browser` fail (offline, proxy, locked-down CI).
// Anything missed here is installed on first use anyway (src/setup.mjs).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.HALLPASS_NO_AUTO_INSTALL === '1' || process.env.CI || process.env.HALLPASS_SKIP_POSTINSTALL === '1') process.exit(0);
const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'hallpass.mjs'), 'setup'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 15 * 60_000 });
if (r.status !== 0) process.stderr.write('hallpass: could not finish browser setup now; it will be retried automatically on first use (or run: hallpass setup)\n');
process.exit(0);
