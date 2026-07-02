/**
 * Hosted-lane waitlist capture — the shared core. Fully local: appends
 * normalized signups to a JSONL file. No external service, no keys.
 *
 * Two consumers:
 *   - the gateway's opt-in `POST /waitlist` endpoint (ships in the package,
 *     armed with MERIDIAN_WAITLIST_ENDPOINT=1) — what a landing page POSTs to
 *   - `scripts/hosted/waitlist.mts`, the local CLI (add/list/count)
 *
 * Storage: $MERIDIAN_WAITLIST (default ~/.meridian/waitlist.jsonl).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WaitlistEntry {
  email: string;
  plan?: string;
  note?: string;
  source?: string;
  /** ISO timestamp; injected by the caller (kept out of core for determinism). */
  ts: string;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
