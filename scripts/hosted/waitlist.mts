/**
 * Hosted-lane waitlist intent capture — READY TO RUN, fully local.
 *
 * "Wire the paid lane before virality, not after." A landing page
 * ("Hosted MERIDIAN / Quartz — join the waitlist") POSTs signups here; this
 * appends them to a local JSONL. No external service, no keys, no network — it
 * is the smallest honest thing that captures intent during a launch spike so
 * the paid lane has a pipeline from day one.
 *
 *   npx tsx scripts/hosted/waitlist.mts add --email you@example.com --plan secure-memory --note "from HN"
 *   npx tsx scripts/hosted/waitlist.mts list
 *   npx tsx scripts/hosted/waitlist.mts count
 *
 * Storage: $MERIDIAN_WAITLIST (default ~/.meridian/waitlist.jsonl).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface WaitlistEntry {
  email: string;
  plan?: string;
  note?: string;
  source?: string;
  /** ISO timestamp; injected by the caller (kept out of core for determinism). */
  ts: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Validate + append one entry. Pure given (entry, path): the caller supplies
 *  the timestamp so this is deterministic and unit-testable. Returns the
 *  normalized entry. Throws on an invalid email or a duplicate. */
export function recordWaitlist(entry: WaitlistEntry, dbPath: string): WaitlistEntry {
  const email = entry.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`invalid email: ${entry.email}`);
  const normalized: WaitlistEntry = {
    email,
    plan: entry.plan?.trim() || undefined,
    note: entry.note?.trim() || undefined,
    source: entry.source?.trim() || undefined,
    ts: entry.ts,
  };
  if (readWaitlist(dbPath).some((e) => e.email === email)) {
    throw new Error(`already on the waitlist: ${email}`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  appendFileSync(dbPath, `${JSON.stringify(normalized)}\n`);
  return normalized;
}

/** Read all entries; skips any corrupt line rather than throwing. */
export function readWaitlist(dbPath: string): WaitlistEntry[] {
  if (!existsSync(dbPath)) return [];
  const out: WaitlistEntry[] = [];
  for (const line of readFileSync(dbPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as WaitlistEntry);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

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
