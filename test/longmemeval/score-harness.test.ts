/**
 * LongMemEval scoring + harness wiring — deterministic, no dataset, no model.
 * Locks the offline scorer's behavior and proves the harness ingest→recall→
 * answer→score loop runs end-to-end with injected stubs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  EncodeResult,
  RecallResult,
} from '../../src/cortex/types.js';
import type { EncodeOptions, MemoryProvider, RecallOptions } from '../../src/memory/provider.js';
import {
  isAbstentionText,
  isAbstentionType,
  normalizeAnswer,
  scoreOffline,
  tokenF1,
  judgePrompt,
} from '../../scripts/longmemeval/score.js';
import { runInstance, summarize } from '../../scripts/longmemeval/harness.js';
import type { InstanceResult, LongMemEvalInstance } from '../../scripts/longmemeval/types.js';

describe('LongMemEval score — offline scorer', () => {
  it('normalizes and detects abstentions', () => {
    assert.equal(normalizeAnswer('  Paris, France! '), 'paris france');
    assert.equal(isAbstentionText("I don't have that information."), true);
    assert.equal(isAbstentionText('The capital is Paris.'), false);
    assert.equal(isAbstentionType('single-session-abstention'), true);
    assert.equal(isAbstentionType('multi-session'), false);
  });

  it('tokenF1 rewards overlap and is 0 on disjoint', () => {
    assert.equal(tokenF1('the red car', 'the red car'), 1);
    assert.equal(tokenF1('apples', 'oranges'), 0);
    assert.ok(tokenF1('a blue sedan car', 'a blue car') > 0.5);
  });

  it('scores a factual answer correct by containment', () => {
    assert.equal(scoreOffline('multi-session', 'The answer is Paris.', 'Paris'), true);
    assert.equal(scoreOffline('multi-session', 'It is Berlin.', 'Paris'), false);
  });

  it('scores abstention instances on whether the prediction abstains', () => {
    assert.equal(scoreOffline('single-session-abstention', 'There is no information about that.', 'N/A'), true);
    assert.equal(scoreOffline('single-session-abstention', 'It was on Tuesday.', 'N/A'), false);
  });

  it('marks a non-abstention answer wrong when the model abstains', () => {
    assert.equal(scoreOffline('multi-session', "I don't know.", 'Paris'), false);
  });

  it('judgePrompt flags abstention-type questions', () => {
    assert.match(judgePrompt('single-session-abstention', 'q', 'g', 'p'), /ABSTENTION/);
    assert.doesNotMatch(judgePrompt('multi-session', 'q', 'g', 'p'), /ABSTENTION/);
  });
});

/** In-memory stub provider: recall returns the concatenated encoded contents,
 *  so a stub answerer can "answer from memory" deterministically. */
function stubProvider(): MemoryProvider & { encoded: string[] } {
  const encoded: string[] = [];
  return {
    encoded,
    agentId: 'stub',
    async encode(content: string, _o?: EncodeOptions): Promise<EncodeResult> {
      encoded.push(content);
      return { memoryId: encoded.length, novelty: 1, encoded: true };
    },
    async recall(query: string, _o?: RecallOptions): Promise<RecallResult> {
      // Return only memories that share a token with the query (toy retrieval).
      const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      const hits = encoded.filter((c) => c.toLowerCase().split(/\W+/).some((t) => q.has(t)));
      const context = hits.join('\n');
      return { context, memories: [], artifacts: [], tokenCount: context.length, tokenBudget: 2000 };
    },
    async listArtifacts() {
      return { agentId: 'stub', sinceHours: 0, cutoff: '', count: 0, artifacts: [] };
    },
    async dream() {
      return { cycleType: 'full', durationMs: 0, insights: [], stats: {} };
    },
    async health() {
      return { status: 'ok', database: 'connected' };
    },
    async stats() {
      return null;
    },
    async reconsolidate() {
      return { ok: true };
    },
  };
}

const INSTANCE: LongMemEvalInstance = {
  question_id: 'q1',
  question_type: 'multi-session',
  question: 'What color is the sedan?',
  answer: 'blue',
  haystack_sessions: [
    [{ role: 'user', content: 'My sedan is blue.' }],
    [{ role: 'assistant', content: 'Noted, the weather is nice.' }],
  ],
  haystack_dates: ['2026-01-01', '2026-01-02'],
};

describe('LongMemEval harness — ingest → recall → answer → score', () => {
  it('ingests all turns, recalls the evidence, and scores a correct answer', async () => {
    const provider = stubProvider();
    const r = await runInstance(INSTANCE, {
      providerFor: async () => provider,
      // Stub answerer: pull the colour out of the recalled context.
      answer: async (_q, context) => (/blue/i.test(context) ? 'It is blue.' : 'no information'),
    });
    assert.equal(r.ingestedTurns, 2, 'both haystack turns ingested');
    assert.equal(provider.encoded.length, 2);
    assert.ok(provider.encoded[0].includes('[2026-01-01]'), 'session date prefixed for temporal reasoning');
    assert.equal(r.correct, true);
    assert.equal(r.scoredBy, 'offline');
  });

  it('captures a provider error per-instance instead of throwing the run', async () => {
    const r = await runInstance(INSTANCE, {
      providerFor: async () => {
        throw new Error('provider down');
      },
      answer: async () => 'x',
    });
    assert.equal(r.correct, false);
    assert.match(r.error ?? '', /provider down/);
  });

  it('summarize computes accuracy, per-type, and abstention breakdowns', () => {
    const results: InstanceResult[] = [
      { question_id: 'a', question_type: 'multi-session', question: '', goldAnswer: '', predictedAnswer: '', correct: true, scoredBy: 'offline', isAbstention: false, recallTokens: 0, ingestedTurns: 0 },
      { question_id: 'b', question_type: 'multi-session', question: '', goldAnswer: '', predictedAnswer: '', correct: false, scoredBy: 'offline', isAbstention: false, recallTokens: 0, ingestedTurns: 0 },
      { question_id: 'c', question_type: 'single-session-abstention', question: '', goldAnswer: '', predictedAnswer: '', correct: true, scoredBy: 'offline', isAbstention: true, recallTokens: 0, ingestedTurns: 0 },
    ];
    const s = summarize(results, { dataset: 'd', provider: 'embedded', model: 'none' }, 'offline');
    assert.equal(s.total, 3);
    assert.equal(s.correct, 2);
    assert.ok(Math.abs(s.accuracy - 2 / 3) < 1e-9);
    assert.equal(s.byType['multi-session'].total, 2);
    assert.equal(s.abstention.total, 1);
    assert.equal(s.abstention.correct, 1);
  });
});
