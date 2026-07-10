/**
 * The [SILENT] automation contract: prompts promise "only push when it
 * matters"; these tests pin the runtime half — what counts as a silent run
 * and what survives marker stripping for the memory encode.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { automationRunIsSilent, stripSilentMarker } from '../../src/automations/manager.js';

describe('automation [SILENT] contract', () => {
  it('detects the marker case-insensitively with leading whitespace', () => {
    assert.ok(automationRunIsSilent('[SILENT] scanned 12, nothing on fire', 'inbox-scan'));
    assert.ok(automationRunIsSilent('  [silent] gmail_search unavailable', 'inbox-scan'));
  });

  it('treats a fully-exhausted provider chain as silent — outage noise never pushes', () => {
    assert.ok(
      automationRunIsSilent('(inbox-scan produced no output — provider chain exhausted)', 'inbox-scan'),
    );
  });

  it('a substantive reply is NOT silent', () => {
    assert.ok(!automationRunIsSilent('INBOX (17:00)\n- [ron] contract attached', 'inbox-scan'));
    assert.ok(!automationRunIsSilent('Morning brief: 3 commitments due today…', 'morning-brief'));
  });

  it('a mid-text mention of the word silent does not suppress', () => {
    assert.ok(!automationRunIsSilent('The client went [SILENT] on us this week.', 'weekly'));
  });

  it('stripSilentMarker keeps the internal note for the memory encode', () => {
    assert.equal(stripSilentMarker('[SILENT] scanned 12, nothing on fire'), 'scanned 12, nothing on fire');
    assert.equal(stripSilentMarker('[SILENT]'), '(silent run, no content)');
  });
});
