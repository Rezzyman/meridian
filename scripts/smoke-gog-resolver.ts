/**
 * Smoke test the gog resolver in isolation. Triggers download from GitHub
 * Releases, verifies checksum, extracts, runs --version on the result.
 *
 * Run: pnpm exec tsx scripts/smoke-gog-resolver.ts
 */

import { resolveGog, runGog, GOG_VERSION } from '../src/tools/gog.js';

console.log(`target gog version: ${GOG_VERSION}`);
console.log(`platform: ${process.platform}-${process.arch}`);

const path = await resolveGog({ allowPathFallback: false });
console.log(`resolved to: ${path}`);

const versionResult = await runGog({
  args: ['--version'],
  client: 'smoke',
  json: false,
});
console.log(`exit: ${versionResult.exitCode}`);
console.log(`stdout: ${versionResult.stdout.trim()}`);
if (versionResult.stderr.trim()) console.log(`stderr: ${versionResult.stderr.trim()}`);
