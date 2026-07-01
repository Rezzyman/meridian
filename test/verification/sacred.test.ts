/**
 * Tests for the operator-config-driven sacred-topic output guard.
 *
 * Verifies that buildSacredGuard ships only universal, identity-free
 * defaults out of the box, layers operator-owned topics/patterns on top,
 * survives malformed regex, and produces the exact refusal strings the
 * source dictates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSacredGuard, sacredViolation } from '../../src/verification/sacred.js';
import type { SacredGuard } from '../../src/verification/sacred.js';
import { OperatorConfigSchema } from '../../src/config/schema.js';
import type { OperatorConfig } from '../../src/config/schema.js';

const DEFAULT_REFUSAL =
  'That is private information I do not share on this channel. I can take a message for the operator to follow up directly.';

/** Build a parsed OperatorConfig from a partial shape via the real schema. */
function makeOperator(overrides: Record<string, unknown> = {}): OperatorConfig {
  return OperatorConfigSchema.parse(overrides);
}

test('no operator → universal defaults only, none of them a person name', () => {
  const guard = buildSacredGuard();
  // Defaults are exactly the three universal patterns.
  assert.equal(guard.patterns.length, 3);
  // Dollar figures of 3+ digits fire.
  assert.ok(sacredViolation('I paid $4,500', guard));
  assert.ok(sacredViolation('that is $1,200 total', guard));
  // Generic family references fire.
  assert.ok(sacredViolation('tell my wife I called', guard));
  assert.ok(sacredViolation('ask my son about it', guard));
  // SSN fires.
  assert.ok(sacredViolation('ssn 123-45-6789 here', guard));
  // Innocuous text does not.
  assert.equal(sacredViolation('the weather is nice', guard), null);
  // No default pattern is a literal person's name: a bare name is clean.
  assert.equal(sacredViolation('Dana Reyes stopped by', guard), null);
});

test('operator with no sensitivity behaves like universal defaults', () => {
  const guard = buildSacredGuard(makeOperator({ name: 'Acme Co' }));
  assert.equal(guard.patterns.length, 3);
  assert.ok(sacredViolation('I paid $9,999', guard));
  assert.equal(sacredViolation('the weather is nice', guard), null);
});

test('sacredTopics match case-insensitively as whole words', () => {
  const guard = buildSacredGuard(
    makeOperator({ sensitivity: { sacredTopics: ['Oak Hills', 'Dana Reyes'] } }),
  );
  // Two universal + two topics.
  assert.equal(guard.patterns.length, 5);
  assert.ok(sacredViolation('they live near Oak Hills', guard));
  assert.ok(sacredViolation('it is in oak hills now', guard)); // case-insensitive
  assert.ok(sacredViolation('call dana reyes back', guard)); // case-insensitive
  assert.equal(sacredViolation('nothing private here', guard), null);
});

test('topic does not fire on a substring inside a larger word (\\b boundary)', () => {
  const guard = buildSacredGuard(makeOperator({ sensitivity: { sacredTopics: ['Ann'] } }));
  // 'Ann' as a whole word fires.
  assert.ok(sacredViolation('Ann is here', guard));
  // 'announcement' contains 'Ann' as a substring but not a whole word.
  assert.equal(sacredViolation('here is an announcement', guard), null);
  assert.equal(sacredViolation('Annette stopped by', guard), null);
});

test('blank topics are skipped, not turned into matchers', () => {
  const guard = buildSacredGuard(
    makeOperator({ sensitivity: { sacredTopics: ['', '   ', 'Oak Hills'] } }),
  );
  // Only the one non-blank topic added beyond the 3 universal defaults.
  assert.equal(guard.patterns.length, 4);
  assert.ok(sacredViolation('Oak Hills district', guard));
});

test('sacredPatterns are raw regex sources', () => {
  const guard = buildSacredGuard(
    makeOperator({ sensitivity: { sacredPatterns: ['acct-\\d+'] } }),
  );
  assert.equal(guard.patterns.length, 4);
  assert.ok(sacredViolation('reference acct-9931 on file', guard));
  assert.equal(sacredViolation('reference acct-none on file', guard), null);
});

test('malformed sacredPattern does not crash; valid patterns still build', () => {
  let guard: SacredGuard | undefined;
  assert.doesNotThrow(() => {
    guard = buildSacredGuard(
      makeOperator({ sensitivity: { sacredPatterns: ['(', 'acct-\\d+'] } }),
    );
  });
  assert.ok(guard);
  // 3 universal + only the 1 valid pattern (malformed swallowed).
  assert.equal(guard.patterns.length, 4);
  assert.ok(sacredViolation('see acct-42', guard));
});

test('topicToPattern escapes regex metachars and matches literally', () => {
  const guard = buildSacredGuard(makeOperator({ sensitivity: { sacredTopics: ['a.b'] } }));
  // The '.' is literal: matches 'a.b' but not 'axb'.
  assert.ok(sacredViolation('the code is a.b today', guard));
  assert.equal(sacredViolation('the code is axb today', guard), null);
});

test('refusal: generic default when no operator', () => {
  const guard = buildSacredGuard();
  assert.equal(guard.refusal, DEFAULT_REFUSAL);
});

test('refusal: generic default when operator has no name', () => {
  const guard = buildSacredGuard(makeOperator({}));
  assert.equal(guard.refusal, DEFAULT_REFUSAL);
});

test('refusal: personalized with operator.name when set', () => {
  const guard = buildSacredGuard(makeOperator({ name: 'Dana' }));
  assert.equal(
    guard.refusal,
    'That is private information I do not share on this channel. I can take a message for Dana to follow up directly.',
  );
});

test('refusal: explicit sensitivity.refusal overrides both default and name', () => {
  const custom = 'No comment.';
  const guard = buildSacredGuard(
    makeOperator({ name: 'Dana', sensitivity: { refusal: custom } }),
  );
  assert.equal(guard.refusal, custom);
});

test('sacredViolation returns the first matching pattern, null when clean', () => {
  const guard = buildSacredGuard(makeOperator({ sensitivity: { sacredTopics: ['Oak Hills'] } }));
  const hit = sacredViolation('paid $1,200 near Oak Hills', guard);
  assert.ok(hit instanceof RegExp);
  // The dollar pattern is registered before the topic, so it matches first.
  assert.ok(hit.test('$1,200'));
  assert.equal(sacredViolation('all good here', guard), null);
});

// ─── Sacred guard gating (which turns get the guard) ─────────────────────────
// The guard used to fire on voice only, leaking sacred topics to untrusted
// senders on every text channel. It now fires for the public voice line AND any
// sender the gateway did not resolve to the operator, on any channel.
import { shouldGuardSacred } from '../../src/agent/turn.js';

test('shouldGuardSacred: voice is always guarded (no regression)', () => {
  assert.equal(shouldGuardSacred('voice', undefined), true);
  assert.equal(shouldGuardSacred('voice', false), true);
  assert.equal(shouldGuardSacred('voice', true), true);
});

test('shouldGuardSacred: untrusted senders on text channels are now guarded', () => {
  for (const ch of ['sms', 'whatsapp', 'slack', 'discord', 'matrix', 'telegram'] as const) {
    assert.equal(shouldGuardSacred(ch, false), true, `${ch} untrusted → guarded`);
  }
});

test('shouldGuardSacred: the trusted operator sees their own topics', () => {
  assert.equal(shouldGuardSacred('cli', undefined), false); // REPL is the operator
  assert.equal(shouldGuardSacred('telegram', true), false); // resolved operator
  assert.equal(shouldGuardSacred('gateway', undefined), false);
});
