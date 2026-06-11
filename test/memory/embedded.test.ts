/**
 * EmbeddedMemoryProvider — zero-config local memory (JSONL + TF-IDF recall).
 * Covers the MemoryProvider contract, cross-instance persistence, ranking,
 * filters, and the schema relaxation that lets embedded boot with no
 * Neon/Voyage keys.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AgentEnvSchema } from '../../src/config/schema.js';
import { EmbeddedMemoryProvider } from '../../src/memory/embedded-memory-provider.js';

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'embedded-test-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function provider(name: string): EmbeddedMemoryProvider {
  return new EmbeddedMemoryProvider({ agentId: 'test', dbPath: join(dir, `${name}.jsonl`) });
}

describe('EmbeddedMemoryProvider', () => {
  it('encode → recall round-trip on keyword overlap', async () => {
    const p = provider('roundtrip');
    await p.encode('My dog is named Pixel and she is a husky.', { source: 'meridian:cli:s1' });
    await p.encode('The quarterly budget review is on Friday.', { source: 'meridian:cli:s1' });
    const r = await p.recall('what breed is my dog');
    assert.equal(r.memories.length, 1);
    assert.match(r.memories[0].content, /husky/);
    assert.match(r.context, /husky/);
    assert.equal(r.memories[0].source, 'meridian:cli:s1');
  });

  it('TF-IDF ranks the memory sharing rarer terms higher', async () => {
    const p = provider('tfidf');
    // "the meeting" terms are common across the corpus; "Pixel/husky" are rare.
    await p.encode('The meeting is on Monday.');
    await p.encode('The meeting is on Tuesday.');
    await p.encode('The meeting about Pixel the husky is on Wednesday.');
    const r = await p.recall('when is the Pixel husky meeting');
    assert.match(r.memories[0].content, /Pixel the husky/);
  });

  it('persists to disk across provider instances (cross-session memory)', async () => {
    const path = join(dir, 'persist.jsonl');
    const a = new EmbeddedMemoryProvider({ agentId: 'test', dbPath: path });
    await a.encode('The staging server runs on port 18891.', { source: 'meridian:cli:s1' });
    assert.ok(existsSync(path));
    // A fresh instance (a restart) reads the JSONL back.
    const b = new EmbeddedMemoryProvider({ agentId: 'test', dbPath: path });
    const r = await b.recall('what port does staging run on');
    assert.match(r.memories[0]?.content ?? '', /18891/);
  });

  it('honors sensitivityFilter', async () => {
    const p = provider('sens');
    await p.encode('public fact about widgets', { sensitivity: 'public' });
    await p.encode('internal secret about widgets', { sensitivity: 'internal' });
    const pub = await p.recall('widgets', { sensitivityFilter: ['public'] });
    assert.equal(pub.memories.length, 1);
    assert.match(pub.memories[0].content, /public/);
  });

  it('respects tokenBudget', async () => {
    const p = provider('budget');
    for (let i = 0; i < 20; i++) await p.encode(`widget report number ${i} with shared keyword widget`);
    const r = await p.recall('widget', { tokenBudget: 40 });
    assert.ok(r.tokenCount <= 40 || r.memories.length === 1);
    assert.ok(r.memories.length < 20);
  });

  it('novelty drops for near-duplicate content', async () => {
    const p = provider('novelty');
    const first = await p.encode('The vendor invoice for Acme is overdue by ten days.');
    assert.equal(first.novelty, 1);
    const dup = await p.encode('The vendor invoice for Acme is overdue by ten days.');
    assert.ok(dup.novelty < 0.5, `near-duplicate novelty should be low, got ${dup.novelty}`);
  });

  it('health + stats report a live local store', async () => {
    const p = provider('health');
    await p.encode('one');
    const h = await p.health();
    assert.equal(h.status, 'ok');
    assert.equal(h.database, 'connected');
    const s = await p.stats();
    assert.equal(s.memoryCount, 1);
    assert.equal(s.agentId, 'test');
  });

  it('reconsolidate edits a memory and survives reload', async () => {
    const path = join(dir, 'recon.jsonl');
    const a = new EmbeddedMemoryProvider({ agentId: 'test', dbPath: path });
    const enc = await a.encode('original quux content');
    const ok = await a.reconsolidate(enc.memoryId, 'edited quux content');
    assert.equal(ok.ok, true);
    const b = new EmbeddedMemoryProvider({ agentId: 'test', dbPath: path });
    const r = await b.recall('quux');
    assert.match(r.memories[0].content, /edited/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /original quux/);
  });

  it('empty query returns nothing (no crash)', async () => {
    const p = provider('empty');
    await p.encode('something');
    const r = await p.recall('the and of');
    assert.equal(r.memories.length, 0);
  });
});

describe('embedded mode schema relaxation', () => {
  it('embedded env parses with NO Neon/Voyage keys', () => {
    const env = AgentEnvSchema.parse({
      MERIDIAN_AGENT: 'demo',
      CORTEX_AGENT_ID: 'demo',
      MERIDIAN_MEMORY_PROVIDER: 'embedded',
    });
    assert.equal(env.MERIDIAN_MEMORY_PROVIDER, 'embedded');
    assert.equal(env.NEON_DATABASE_URL, undefined);
  });

  it('cortex mode still REQUIRES Neon + Voyage', () => {
    const r = AgentEnvSchema.safeParse({
      MERIDIAN_AGENT: 'demo',
      CORTEX_AGENT_ID: 'demo',
      MERIDIAN_MEMORY_PROVIDER: 'cortex',
    });
    assert.equal(r.success, false);
  });
});
