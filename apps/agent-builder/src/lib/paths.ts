/**
 * Server-side path resolution. The builder app lives at
 * <meridian repo>/apps/agent-builder and drives the repo's CLI with the
 * repo's own tsx, so agent behavior always matches the checked-out source.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Meridian repo root. Override with MERIDIAN_REPO for non-standard layouts. */
export function meridianRepo(): string {
  const candidates = [
    process.env.MERIDIAN_REPO,
    resolve(process.cwd(), '..', '..'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'src', 'cli', 'main.ts'))) return c;
  }
  throw new Error(
    'Could not locate the meridian repo. Run the builder from <meridian>/apps/agent-builder or set MERIDIAN_REPO.',
  );
}

/** ~/.meridian (or MERIDIAN_HOME) — same resolution as the runtime's home.ts. */
export function meridianHome(): string {
  return process.env.MERIDIAN_HOME ?? join(homedir(), '.meridian');
}

export function agentRoot(slug: string): string {
  return join(meridianHome(), slug);
}

export function tsxBin(): string {
  return join(meridianRepo(), 'node_modules', '.bin', 'tsx');
}

export function cliMain(): string {
  return join(meridianRepo(), 'src', 'cli', 'main.ts');
}

/** Builder-owned state dir (dot-prefixed so the CLI's agent listing skips it). */
export function builderStateDir(): string {
  return join(meridianHome(), '.builder');
}
