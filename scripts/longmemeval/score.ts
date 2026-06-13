/**
 * LongMemEval scoring — two paths, both honestly labeled.
 *
 *   judge   — the official-style metric: a model judges whether the predicted
 *             answer matches the gold answer (type-aware prompt). This is what
 *             you publish; it requires a model (gated behind --confirm-live).
 *   offline — a lexical APPROXIMATION (normalized containment + token-F1 +
 *             abstention detection) that needs no model, so the harness can be
 *             exercised and unit-tested with zero external calls. It is NOT the
 *             official metric and is labeled as such everywhere it appears.
 *
 * Abstention instances (gold answer indicates "no information in memory") are
 * scored on whether the prediction correctly abstains — the metric that
 * separates a faithful memory system from one that confabulates.
 */

import type { LongMemEvalQuestionType } from './types.js';

const ABSTENTION_MARKERS = [
  'no information',
  'have no information',
  'not mentioned',
  'not enough information',
  "don't know",
  'do not know',
  "don't have",
  'do not have',
  'cannot determine',
  "can't determine",
  'unable to determine',
  'no record',
  'not provided',
  'not available',
  'no relevant',
  'i have no',
];

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the text reads as an abstention ("I don't have that information"). */
export function isAbstentionText(s: string): boolean {
  const n = normalizeAnswer(s);
  return ABSTENTION_MARKERS.some((m) => n.includes(normalizeAnswer(m)));
}

/** A question type whose gold answer is an abstention. */
export function isAbstentionType(type: LongMemEvalQuestionType): boolean {
  return typeof type === 'string' && type.includes('abstention');
}

function tokens(s: string): string[] {
  return normalizeAnswer(s).split(' ').filter(Boolean);
}

/** Token-level F1 between prediction and gold (0..1). */
export function tokenF1(pred: string, gold: string): number {
  const p = tokens(pred);
  const g = tokens(gold);
  if (p.length === 0 && g.length === 0) return 1;
  if (p.length === 0 || g.length === 0) return 0;
  const gCount = new Map<string, number>();
  for (const t of g) gCount.set(t, (gCount.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = gCount.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      gCount.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Offline (no-model) correctness approximation for one instance.
 *   - abstention gold → correct iff the prediction abstains.
 *   - otherwise → correct iff the gold answer is contained in the prediction
 *     (normalized substring) OR token-F1 ≥ threshold. Containment handles short
 *     factual golds ("Paris"); F1 handles longer paraphrased golds.
 * This OVER-credits verbose predictions and is intentionally approximate — use
 * the judge path for a publishable number.
 */
export function scoreOffline(
  type: LongMemEvalQuestionType,
  predicted: string,
  gold: string,
  f1Threshold = 0.5,
): boolean {
  if (isAbstentionType(type)) return isAbstentionText(predicted);
  // A non-abstention question where the model abstained is wrong.
  if (isAbstentionText(predicted) && !isAbstentionText(gold)) return false;
  const p = normalizeAnswer(predicted);
  const g = normalizeAnswer(gold);
  if (g.length > 0 && p.includes(g)) return true;
  return tokenF1(predicted, gold) >= f1Threshold;
}

/** Type-aware judge prompt builder (used by the model judge path). */
export function judgePrompt(
  type: LongMemEvalQuestionType,
  question: string,
  gold: string,
  predicted: string,
): string {
  const abstain = isAbstentionType(type)
    ? '\nNOTE: this is an ABSTENTION question — the correct behavior is to say the information is not available. Mark correct ONLY if the response abstains.'
    : '';
  return (
    `Question: ${question}\n` +
    `Reference (gold) answer: ${gold}\n` +
    `Model response: ${predicted}\n` +
    `Question type: ${type}.${abstain}\n\n` +
    'Does the model response correctly answer the question, consistent with the reference? ' +
    'Ignore wording differences; judge only factual correctness.'
  );
}
