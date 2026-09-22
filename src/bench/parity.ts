/**
 * Harness parity bench (WS6): pure helpers. Both harnesses are driven through
 * the same OpenAI-compatible completions route on the same agent home and
 * the same memory clone, one at a time. This module holds the checks and the
 * aggregation; `scripts/harness-parity.mts` is the runner.
 *
 * Honesty rules (docs/harness-comparison-methodology.md): every number comes
 * from a recorded run; a dimension a harness does not expose is "unmeasured",
 * never a guess; results stay internal unless the methodology allows.
 */
import { stripAssistantSpeak, stripMarkdown } from '../agent/text-style.js';
import { stripNarration } from '../automations/narration.js';

export interface PromptCase {
  id: string;
  category: string;
  prompt: string;
  /** Regexes the reply must match (all). */
  mustMatch?: string[];
  /** Regexes the reply must not match (any). */
  mustNotMatch?: string[];
  maxChars?: number;
}

export interface MemoryCase {
  id: string;
  seed: string;
  ask: string;
  expect: string;
}

export interface CheckResult {
  ok: boolean;
  failures: string[];
}

export function checkReply(c: PromptCase, reply: string): CheckResult {
  const failures: string[] = [];
  const text = (reply ?? '').trim();
  if (!text) failures.push('empty');
  if (/produced no output/i.test(text)) failures.push('no-output marker');
  if (stripNarration(text) !== text) failures.push('narration prefix');
  if (stripAssistantSpeak(text) !== text) failures.push('assistant-speak');
  if (stripMarkdown(text) !== text && (text.match(/^\s*(#{1,6}\s|[-*•]\s)/gm) ?? []).length >= 3)
    failures.push('markdown wall');
  if (c.maxChars && text.length > c.maxChars) failures.push(`over ${c.maxChars} chars`);
  for (const re of c.mustMatch ?? [])
    if (!new RegExp(re, 'i').test(text)) failures.push(`missing /${re}/`);
  for (const re of c.mustNotMatch ?? [])
    if (new RegExp(re, 'i').test(text)) failures.push(`forbidden /${re}/`);
  return { ok: failures.length === 0, failures };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export interface HarnessRun {
  name: string;
  functional: { total: number; passed: number; failures: Record<string, string[]> };
  memory: { total: number; hits: number; misses: string[] };
  reliability: { turns: number; errors: number; p50Ms: number; p95Ms: number };
  humanFeel?: { comparisons: number; preferred: number } | 'unmeasured';
  usdPerTurn?: number | 'unmeasured';
}

export interface Verdict {
  ok: boolean;
  reasons: string[];
}

/** Meridian (`a`) must meet or beat the incumbent (`b`) on every axis. */
export function judgeParity(
  a: HarnessRun,
  b: HarnessRun,
  opts: { p95Slack?: number; humanFeelMin?: number } = {},
): Verdict {
  const reasons: string[] = [];
  const rate = (r: HarnessRun) =>
    r.functional.total ? r.functional.passed / r.functional.total : 0;
  if (rate(a) < rate(b)) reasons.push(`functional pass ${pct(rate(a))} < ${pct(rate(b))}`);
  const mem = (r: HarnessRun) => (r.memory.total ? r.memory.hits / r.memory.total : 0);
  if (mem(a) < mem(b)) reasons.push(`memory hit ${pct(mem(a))} < ${pct(mem(b))}`);
  const err = (r: HarnessRun) =>
    r.reliability.turns ? r.reliability.errors / r.reliability.turns : 0;
  if (err(a) > err(b)) reasons.push(`error rate ${pct(err(a))} > ${pct(err(b))}`);
  const slack = opts.p95Slack ?? 0.2;
  if (b.reliability.p95Ms > 0 && a.reliability.p95Ms > b.reliability.p95Ms * (1 + slack))
    reasons.push(
      `p95 ${a.reliability.p95Ms}ms > ${Math.round(b.reliability.p95Ms * (1 + slack))}ms`,
    );
  const min = opts.humanFeelMin ?? 0.6;
  if (a.humanFeel && a.humanFeel !== 'unmeasured' && a.humanFeel.comparisons > 0) {
    const pref = a.humanFeel.preferred / a.humanFeel.comparisons;
    if (pref < min) reasons.push(`human-feel preference ${pct(pref)} < ${pct(min)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

/** Pairwise judge prompt: blind, randomized order handled by the caller. */
export function judgePrompt(question: string, left: string, right: string): string {
  return [
    'You are judging two text replies to the same message from a person to their personal assistant.',
    'Prefer the reply that reads like a sharp, warm human texting: short, plain, first person, no headers or bullet walls,',
    'no "As an AI", no sign-offs, grounded and specific, asks one question when something is missing.',
    'Ignore which is longer. Ignore formatting flourishes. Judge naturalness, brevity, role knowledge, and absence of chatbot tells.',
    '',
    `MESSAGE: ${question}`,
    '',
    `REPLY A:\n${left}`,
    '',
    `REPLY B:\n${right}`,
    '',
    'Answer with JSON only: {"winner":"A"|"B"|"tie","reason":"<one sentence>"}',
  ].join('\n');
}

export function parseJudge(text: string): 'A' | 'B' | 'tie' | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const v = (JSON.parse(m[0]) as { winner?: string }).winner;
    return v === 'A' || v === 'B' || v === 'tie' ? v : null;
  } catch {
    return null;
  }
}
