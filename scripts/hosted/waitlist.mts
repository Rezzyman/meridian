/**
 * Hosted-lane waitlist CLI — a thin wrapper over the shared core in
 * `src/hosted/waitlist.ts` (the module the gateway's opt-in `POST /waitlist`
 * endpoint also uses; arm that with MERIDIAN_WAITLIST_ENDPOINT=1 when a
 * landing page needs somewhere to POST).
 *
 *   npx tsx scripts/hosted/waitlist.mts add --email you@example.com --plan secure-memory --note "from HN"
 *   npx tsx scripts/hosted/waitlist.mts list
 *   npx tsx scripts/hosted/waitlist.mts count
 *
 * Storage: $MERIDIAN_WAITLIST (default ~/.meridian/waitlist.jsonl).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readWaitlist, recordWaitlist } from '../../src/hosted/waitlist.js';

export { EMAIL_RE, readWaitlist, recordWaitlist } from '../../src/hosted/waitlist.js';
export type { WaitlistEntry } from '../../src/hosted/waitlist.js';

// ─── CLI ───────────────────────────────────────────────────────────────────
// Guarded so importing this module (e.g. from a test) never runs the CLI.

function defaultDbPath(): string {
  return process.env.MERIDIAN_WAITLIST ?? join(homedir(), '.meridian', 'waitlist.jsonl');
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function isMain(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('waitlist.mts') || entry.endsWith('waitlist.js');
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dbPath = flag(argv, 'db') ?? defaultDbPath();
  try {
    if (cmd === 'add') {
      const email = flag(argv, 'email');
      if (!email) throw new Error('--email is required');
      // Date.now()/new Date() are fine in a CLI (not a resumable workflow).
      const saved = recordWaitlist(
        { email, plan: flag(argv, 'plan'), note: flag(argv, 'note'), source: flag(argv, 'source'), ts: new Date().toISOString() },
        dbPath,
      );
      console.log(`✓ added ${saved.email}${saved.plan ? ` (${saved.plan})` : ''} → ${dbPath}`);
    } else if (cmd === 'list') {
      const entries = readWaitlist(dbPath);
      for (const e of entries) console.log(`${e.ts}  ${e.email}  ${e.plan ?? '-'}  ${e.note ?? ''}`);
      console.log(`\n${entries.length} on the waitlist (${dbPath})`);
    } else if (cmd === 'count') {
      console.log(readWaitlist(dbPath).length);
    } else {
      console.log('usage: waitlist.mts <add|list|count> [--email x --plan y --note z --source s --db path]');
      process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
