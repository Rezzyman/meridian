/**
 * LongMemEval harness core — provider-agnostic, dependency-injected, testable.
 *
 * Runs each instance through: ingest haystack → recall → answer → score. The
 * MemoryProvider, the answerer (model call), and the optional judge are all
 * injected, so the runner can wire embedded/CORTEX/Quartz + a real or local
 * model, and tests can wire deterministic stubs with zero external calls.
 *
 * Per-instance isolation is the caller's job: `providerFor(inst)` must return a
 * FRESH, empty memory store per instance, or one haystack bleeds into the next.
 */

import type {
  InstanceResult,
  LongMemEvalInstance,
  RunSummary,
} from './types.js';
import type { MemoryProvider } from '../../src/memory/provider.js';
import { isAbstentionType, scoreOffline } from './score.js';

export interface HarnessDeps {
  /** Fresh, empty memory store per instance (isolation). */
  providerFor: (inst: LongMemEvalInstance) => Promise<MemoryProvider>;
  /** Produce an answer from the question + recalled context (the model call,
   *  or a deterministic stub in tests / dry-run). */
  answer: (question: string, context: string, inst: LongMemEvalInstance) => Promise<string>;
  /** Optional model judge; when absent, offline lexical scoring is used. */
  judge?: (inst: LongMemEvalInstance, predicted: string) => Promise<boolean>;
  /** Recall token budget per question. */
  recallTokenBudget?: number;
  /** Release a per-instance provider (e.g. delete its temp file). */
  releaseProvider?: (provider: MemoryProvider, inst: LongMemEvalInstance) => Promise<void> | void;
  /** Progress callback. */
  onProgress?: (done: number, total: number, last: InstanceResult) => void;
}

/** Encode one instance's haystack into the provider, oldest session first. The
 *  session date is prefixed into the content so temporal-reasoning questions
 *  have the date available even on providers that don't accept an explicit
 *  createdAt (embedded). Encodes are awaited in order so the store is fully
 *  populated before recall. */
async function ingestInstance(provider: MemoryProvider, inst: LongMemEvalInstance): Promise<number> {
  let turns = 0;
  for (let i = 0; i < inst.haystack_sessions.length; i++) {
    const session = inst.haystack_sessions[i];
    const date = inst.haystack_dates?.[i];
    const sid = inst.haystack_session_ids?.[i] ?? `s${i}`;
    const datePrefix = date ? `[${date}] ` : '';
    for (const turn of session) {
      await provider.encode(`${datePrefix}${turn.role.toUpperCase()}: ${turn.content}`, {
        source: `longmemeval:haystack:${sid}`,
        sensitivity: 'internal',
        channel: 'eval',
      });
      turns++;
    }
  }
  return turns;
}

export async function runInstance(
  inst: LongMemEvalInstance,
  deps: HarnessDeps,
): Promise<InstanceResult> {
  let provider: MemoryProvider | undefined;
  try {
    provider = await deps.providerFor(inst);
    const ingestedTurns = await ingestInstance(provider, inst);
    const recall = await provider.recall(inst.question, {
      tokenBudget: deps.recallTokenBudget ?? 2000,
    });
    const predicted = await deps.answer(inst.question, recall.context, inst);
    const correct = deps.judge
      ? await deps.judge(inst, predicted)
      : scoreOffline(inst.question_type, predicted, inst.answer);
    return {
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: inst.question,
      goldAnswer: inst.answer,
      predictedAnswer: predicted,
      correct,
      scoredBy: deps.judge ? 'judge' : 'offline',
      isAbstention: isAbstentionType(inst.question_type),
      recallTokens: recall.tokenCount ?? 0,
      ingestedTurns,
    };
  } catch (err) {
    return {
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: inst.question,
      goldAnswer: inst.answer,
      predictedAnswer: '',
      correct: false,
      scoredBy: deps.judge ? 'judge' : 'offline',
      isAbstention: isAbstentionType(inst.question_type),
      recallTokens: 0,
      ingestedTurns: 0,
      error: (err as Error).message,
    };
  } finally {
    if (provider) await deps.releaseProvider?.(provider, inst);
  }
}

export async function runLongMemEval(
  instances: LongMemEvalInstance[],
  deps: HarnessDeps,
  meta: { dataset: string; provider: string; model: string },
): Promise<RunSummary> {
  const results: InstanceResult[] = [];
  for (const inst of instances) {
    const r = await runInstance(inst, deps);
    results.push(r);
    deps.onProgress?.(results.length, instances.length, r);
  }
  return summarize(results, meta, deps.judge ? 'judge' : 'offline');
}

export function summarize(
  results: InstanceResult[],
  meta: { dataset: string; provider: string; model: string },
  scoredBy: 'judge' | 'offline',
): RunSummary {
  const byType: RunSummary['byType'] = {};
  let correct = 0;
  let absTotal = 0;
  let absCorrect = 0;
  for (const r of results) {
    if (r.correct) correct++;
    if (!byType[r.question_type]) byType[r.question_type] = { total: 0, correct: 0, accuracy: 0 };
    const t = byType[r.question_type];
    t.total++;
    if (r.correct) t.correct++;
    if (r.isAbstention) {
      absTotal++;
      if (r.correct) absCorrect++;
    }
  }
  for (const t of Object.values(byType)) t.accuracy = t.total ? t.correct / t.total : 0;
  return {
    dataset: meta.dataset,
    provider: meta.provider,
    model: meta.model,
    scoredBy,
    total: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    byType,
    abstention: {
      total: absTotal,
      correct: absCorrect,
      accuracy: absTotal ? absCorrect / absTotal : 0,
    },
    results,
  };
}
