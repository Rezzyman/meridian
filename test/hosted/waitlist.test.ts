/**
 * Hosted-lane waitlist capture — local intent pipeline. Deterministic (caller
 * supplies the timestamp); no network, no keys.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { recordWaitlist, readWaitlist } from '../../src/hosted/waitlist.js';

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wl-'));
  return { path: join(dir, 'waitlist.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('waitlist capture', () => {
  it('records and reads back a normalized entry', () => {
    const { path, cleanup } = tmpDb();
    try {
      const saved = recordWaitlist(
        { email: '  You@Example.COM ', plan: 'secure-memory', note: 'from HN', ts: '2026-06-11T00:00:00Z' },
        path,
      );
      assert.equal(saved.email, 'you@example.com', 'email lowercased + trimmed');
      const all = readWaitlist(path);
      assert.equal(all.length, 1);
      assert.equal(all[0].plan, 'secure-memory');
    } finally {
      cleanup();
    }
  });

  it('rejects an invalid email', () => {
    const { path, cleanup } = tmpDb();
    try {
      assert.throws(() => recordWaitlist({ email: 'not-an-email', ts: 't' }, path), /invalid email/);
    } finally {
      cleanup();
    }
  });

  it('rejects a duplicate signup (case-insensitive)', () => {
    const { path, cleanup } = tmpDb();
    try {
      recordWaitlist({ email: 'a@b.co', ts: 't1' }, path);
      assert.throws(() => recordWaitlist({ email: 'A@B.CO', ts: 't2' }, path), /already on the waitlist/);
    } finally {
      cleanup();
    }
  });

  it('tolerates a corrupt line in the store', () => {
    const { path, cleanup } = tmpDb();
    try {
      writeFileSync(path, '{bad json\n{"email":"ok@x.io","ts":"t"}\n');
      const all = readWaitlist(path);
      assert.equal(all.length, 1, 'the one valid line survives');
      assert.equal(all[0].email, 'ok@x.io');
    } finally {
      cleanup();
    }
  });
});
