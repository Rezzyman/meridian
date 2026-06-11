/**
 * Sacred-topic output guard — operator-owned, zero hardcoded identities.
 *
 * The agent must never surface the operator's private entities on an
 * untrusted channel (the public voice line, an external caller). WHICH
 * entities are private is the operator's call, not the framework's: their
 * names live in `operator.sensitivity` in their own config.yaml, populated
 * by `meridian onboard`. Framework source ships only universal,
 * identity-free defaults (a dollar-figure pattern, generic family
 * references) — never a person's name.
 */

import type { OperatorConfig } from '../config/schema.js';

/** Identity-free privacy defaults applied on untrusted channels. These name
 *  no one; they catch the obvious leaks every operator would want blocked. */
const UNIVERSAL_SACRED_PATTERNS: RegExp[] = [
  /\$[0-9][0-9,]{2,}/, // dollar figures ≥ 3 digits
  /\b(?:my (?:wife|husband|spouse|partner|kid|kids|son|daughter|child|children|family))\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
];

const DEFAULT_REFUSAL =
  'That is private information I do not share on this channel. I can take a message for the operator to follow up directly.';

/** Whole-word, case-insensitive matcher for a plain topic phrase. */
function topicToPattern(topic: string): RegExp | null {
  const trimmed = topic.trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null; // a malformed operator pattern must not crash the turn
  }
}

export interface SacredGuard {
  patterns: RegExp[];
  refusal: string;
}

/**
 * Build the sacred-topic matchers for an operator. Universal privacy
 * defaults + the operator's own topics (plain phrases) + advanced raw
 * patterns. Operator name personalizes the default refusal when set.
 */
export function buildSacredGuard(operator?: OperatorConfig): SacredGuard {
  const sensitivity = operator?.sensitivity;
  const patterns: RegExp[] = [...UNIVERSAL_SACRED_PATTERNS];

  for (const topic of sensitivity?.sacredTopics ?? []) {
    const re = topicToPattern(topic);
    if (re) patterns.push(re);
  }
  for (const raw of sensitivity?.sacredPatterns ?? []) {
    const re = safeRegex(raw);
    if (re) patterns.push(re);
  }

  const refusal =
    sensitivity?.refusal ??
    (operator?.name
      ? `That is private information I do not share on this channel. I can take a message for ${operator.name} to follow up directly.`
      : DEFAULT_REFUSAL);

  return { patterns, refusal };
}

/** First matching pattern, or null if the reply is clean. */
export function sacredViolation(reply: string, guard: SacredGuard): RegExp | null {
  for (const p of guard.patterns) {
    if (p.test(reply)) return p;
  }
  return null;
}
