/**
 * Lightweight client-side valence inference. CORTEX server has its own
 * analyzer; this is a fast pre-check so Meridian can tag turns before
 * encoding without an extra round trip.
 */

import type { ValenceVector } from './types.js';

const POSITIVE = /\b(thanks|great|amazing|love|happy|excited|yes|perfect|awesome)\b/i;
const NEGATIVE = /\b(angry|frustrated|broken|bug|wrong|error|fail|hate|sad|stuck)\b/i;
const URGENT = /\b(asap|urgent|now|emergency|critical|stop|halt)\b/i;
const QUESTION = /\?$/;

export function inferValence(content: string, channel?: string): Partial<ValenceVector> {
  const v: Partial<ValenceVector> = { channel };
  const lower = content.toLowerCase();
  if (POSITIVE.test(lower)) {
    v.pleasantness = 0.6;
    v.approach = 0.4;
  }
  if (NEGATIVE.test(lower)) {
    v.pleasantness = -0.5;
    v.approach = -0.2;
  }
  if (URGENT.test(lower)) {
    v.arousal = 0.7;
    v.dominance = 0.4;
  }
  if (QUESTION.test(content.trim())) {
    v.certainty = -0.3;
  }
  if (channel === 'voice') {
    // Voice is inherently more personal; weight novelty higher so cross-call recall fires.
    v.novelty = (v.novelty ?? 0) + 0.2;
  }
  return v;
}
