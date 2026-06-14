/**
 * SessionStore — the JSONL append-log persistence. Covers ordered turn replay,
 * INSERT-OR-REPLACE semantics, operator/recency lookups, traces, and the
 * load-bearing property: data survives a fresh store on the same path (replay).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { MeridianHome } from '../../src/config/home.js';
import type { MeridianTurn } from '../../src/agent/types.js';
import { SessionStore, type TurnTrace } from '../../src/session/store.js';

let tmp: string;
const homeFor = (dir: string) => ({ stateDb: join(dir, 'state.db') }) as unknown as MeridianHome;
const turn = (over: Partial<MeridianTurn> = {}): MeridianTurn => ({
  id: 't1',
  sessionId: 's1',
  role: 'user',
  content: 'hi',
  channel: 'cli',
  ts: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'store-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('stores a session and returns its turns ordered by idx', () => {
    const s = new SessionStore(homeFor(tmp));
    s.startSession({ id: 's1', agentSlug: 'a', createdAt: '2026-01-01T00:00:00Z', turns: [] });
    s.appendTurn(turn({ id: 'b', content: 'second' }), 1);
    s.appendTurn(turn({ id: 'a', content: 'first' }), 0);
    const loaded = s.loadSession('s1');
    assert.equal(loaded?.agentSlug, 'a');
    assert.deepEqual(loaded?.turns.map((t) => t.content), ['first', 'second']);
  });

  it('replaces a turn with the same id (insert-or-replace)', () => {
    const s = new SessionStore(homeFor(tmp));
    s.startSession({ id: 's1', agentSlug: 'a', createdAt: '2026-01-01T00:00:00Z', turns: [] });
    s.appendTurn(turn({ id: 'x', content: 'v1' }), 0);
    s.appendTurn(turn({ id: 'x', content: 'v2' }), 0);
    assert.deepEqual(s.loadSession('s1')?.turns.map((t) => t.content), ['v2']);
  });

  it('preserves toolCalls/verifications on a turn', () => {
    const s = new SessionStore(homeFor(tmp));
    s.startSession({ id: 's1', agentSlug: 'a', createdAt: '2026-01-01T00:00:00Z', turns: [] });
    s.appendTurn(turn({ id: 't', toolCalls: [{ name: 'web_fetch', args: { url: 'x' } }] }), 0);
    assert.deepEqual(s.loadSession('s1')?.turns[0].toolCalls, [{ name: 'web_fetch', args: { url: 'x' } }]);
  });

  it('finds the most recent session for an operator, honoring the idle window', () => {
    const s = new SessionStore(homeFor(tmp));
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();
    s.startSession({ id: 'old', agentSlug: 'a', createdAt: old, turns: [], operatorId: 'op1' });
    s.startSession({ id: 'new', agentSlug: 'a', createdAt: now, turns: [], operatorId: 'op1' });
    s.startSession({ id: 'other', agentSlug: 'a', createdAt: now, turns: [], operatorId: 'op2' });
    assert.equal(s.findRecentByOperator('op1')?.id, 'new');
    assert.equal(s.findRecentByOperator('nobody'), null);
    // 'old' alone, with a 1-day window, is out of range:
    const s2 = new SessionStore(homeFor(mkdtempSync(join(tmpdir(), 'store2-'))));
    s2.startSession({ id: 'stale', agentSlug: 'a', createdAt: old, turns: [], operatorId: 'op1' });
    assert.equal(s2.findRecentByOperator('op1', 24 * 3600), null);
  });

  it('records and reads back reasoning traces', () => {
    const s = new SessionStore(homeFor(tmp));
    const tr: TurnTrace = { turnId: 't1', sessionId: 's1', channel: 'cli', userInput: 'q', reply: 'a', ts: '2026-01-01T00:00:01Z' };
    s.recordTrace(tr);
    s.recordTrace({ ...tr, turnId: 't2', ts: '2026-01-01T00:00:02Z' });
    assert.equal(s.loadTrace('t1')?.reply, 'a');
    assert.equal(s.loadTrace('nope'), null);
    assert.deepEqual(s.listSessionTraces('s1').map((t) => t.turnId), ['t2', 't1']); // latest first
  });

  it('PERSISTS across a fresh store on the same path (JSONL replay)', () => {
    const home = homeFor(tmp);
    const a = new SessionStore(home);
    a.startSession({ id: 's1', agentSlug: 'a', createdAt: '2026-01-01T00:00:00Z', turns: [], operatorId: 'op1' });
    a.appendTurn(turn({ id: 't1', content: 'persisted' }), 0);
    a.recordTrace({ turnId: 't1', sessionId: 's1', channel: 'cli', userInput: 'q', reply: 'r', ts: '2026-01-01T00:00:01Z' });
    a.close();

    const b = new SessionStore(home); // re-open — must replay from disk
    assert.deepEqual(b.loadSession('s1')?.turns.map((t) => t.content), ['persisted']);
    assert.equal(b.findRecentByOperator('op1')?.id, 's1');
    assert.equal(b.loadTrace('t1')?.reply, 'r');
    assert.deepEqual(b.listRecent().map((x) => x.id), ['s1']);
  });
});
