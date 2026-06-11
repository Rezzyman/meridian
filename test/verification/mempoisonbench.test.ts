/**
 * MemPoisonBench regression guard — locks the benchmark's headline
 * guarantees into the green gate so a future change to the recall screen
 * can't silently weaken the defense. Re-runs the version-controlled attack
 * catalog through screenRecall and asserts the invariants the published
 * results.md claims:
 *   - every must-quarantine vector is caught (0 reach the model)
 *   - every must-keep vector survives (0 false positives)
 *   - the known-gap and known-false-positive labels still describe reality
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { RecallMemory } from '../../src/cortex/types.js';
import { screenRecall } from '../../src/verification/memory-integrity.js';

interface Attack {
  id: string;
  category: string;
  poisonContent: string;
  poisonSource: string | null;
  expected: 'quarantine' | 'keep' | 'evade-known-gap' | 'false-positive-known-gap';
}
interface Chain {
  id: string;
  category: string;
  members: Array<{ content: string; source: string | null }>;
  expected: 'cluster-flag' | 'no-flag' | 'evade-known-gap';
}

const CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'mempoison',
  'mempoison-attacks.json',
);
const catalog: { attacks: Attack[]; chains?: Chain[] } = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

function quarantined(a: Attack): boolean {
  const mem: RecallMemory = { id: 1, content: a.poisonContent, source: a.poisonSource, score: 0.9 };
  return screenRecall([mem], `- ${a.poisonContent}`).quarantined.length > 0;
}

describe('MemPoisonBench invariants (single-memory)', () => {
  it('catches every must-quarantine vector (0% poisoning success)', () => {
    const missed = catalog.attacks
      .filter((a) => a.expected === 'quarantine')
      .filter((a) => !quarantined(a));
    assert.deepEqual(missed.map((a) => a.id), [], 'these poison vectors reached the model');
  });

  it('keeps every must-keep vector (0 false positives)', () => {
    const wrong = catalog.attacks.filter((a) => a.expected === 'keep').filter((a) => quarantined(a));
    assert.deepEqual(wrong.map((a) => a.id), [], 'these legitimate memories were wrongly quarantined');
  });

  it('any evade-known-gap vector is honestly still uncaught (label not stale)', () => {
    for (const a of catalog.attacks.filter((x) => x.expected === 'evade-known-gap')) {
      assert.equal(quarantined(a), false, `${a.id} is now caught — relabel it to 'quarantine'`);
    }
  });

  it('catalog has meaningful coverage across attack categories', () => {
    const cats = new Set(catalog.attacks.map((a) => a.category));
    for (const required of [
      'DIRECT_POLICY_INJECTION',
      'PROMPT_INJECTION_IN_MEMORY',
      'AUTHORITY_SPOOFING',
      'PROVENANCE_LAUNDERING',
      'BENIGN_CONTROL',
    ]) {
      assert.ok(cats.has(required), `missing category ${required}`);
    }
    assert.ok(catalog.attacks.length >= 20, 'catalog too small to be credible');
  });
});

describe('MemPoisonBench invariants (cross-memory chains)', () => {
  function screenChain(ch: Chain) {
    const mems: RecallMemory[] = ch.members.map((m, i) => ({
      id: i + 1,
      content: m.content,
      source: m.source,
      score: 0.9,
    }));
    return screenRecall(mems, mems.map((m) => `- ${m.content}`).join('\n'));
  }

  it('flags every cluster-flag chain (and keeps members, injects caution)', () => {
    for (const ch of (catalog.chains ?? []).filter((c) => c.expected === 'cluster-flag')) {
      const r = screenChain(ch);
      assert.ok(r.clusters.length > 0, `${ch.id}: cluster not flagged`);
      assert.equal(r.kept.length, ch.members.length, `${ch.id}: a benign member was over-blocked`);
      assert.ok(r.safeContext.includes('coordinated manipulation'), `${ch.id}: no caution injected`);
    }
  });

  it('does NOT flag no-flag control chains (clustering precision)', () => {
    for (const ch of (catalog.chains ?? []).filter((c) => c.expected === 'no-flag')) {
      assert.equal(screenChain(ch).clusters.length, 0, `${ch.id}: false cluster flag`);
    }
  });
});
