import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NARRATION_RULE, stripNarration } from '../../src/automations/narration.js';

describe('automation narration guard (defect b)', () => {
  it('strips leading planning lines and keeps the brief', () => {
    const leaked =
      "I'll recall the last week of activity first.\nNow I'll check the calendar.\n\nMorning brief, Tuesday.\n- Call Eric at 10.";
    assert.equal(stripNarration(leaked), 'Morning brief, Tuesday.\n- Call Eric at 10.');
  });
  it('leaves a clean brief untouched, byte for byte', () => {
    const clean = 'Morning brief, Tuesday.\n\nI will be brief: two items.';
    assert.equal(stripNarration(clean), clean);
  });
  it('does not touch narration-looking lines after content has started', () => {
    const text = 'Two things today.\nLet me know if the 3pm moves.';
    assert.equal(stripNarration(text), text);
  });
  it('never returns empty when everything looked like narration', () => {
    const all = "I'll check in later.";
    assert.equal(stripNarration(all), all);
  });
  it('the rule tells the model the first character is the message', () => {
    assert.match(NARRATION_RULE, /first character/);
  });
});
