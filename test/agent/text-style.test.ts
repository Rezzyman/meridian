import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEXT_STYLE,
  TEXT_STYLE_RULES,
  humanDelayMs,
  isTextChannel,
  shapeForText,
  stripAssistantSpeak,
  stripMarkdown,
} from '../../src/agent/text-style.js';

describe('human texting shape (WS5b)', () => {
  it('knows which channels are texting', () => {
    for (const c of ['telegram', 'imessage', 'sms', 'whatsapp'])
      assert.equal(isTextChannel(c), true);
    for (const c of ['cli', 'voice', 'gateway', 'slack']) assert.equal(isTextChannel(c), false);
  });

  it('strips markdown into sentences a person would text', () => {
    const md =
      '## Summary\n\n- Eric said the **south slope** has hail bruising.\n- He wants an estimate by Friday.\n\n```\ncode\n```';
    const out = stripMarkdown(md);
    assert.ok(!out.includes('##'));
    assert.ok(!out.includes('**'));
    assert.ok(!out.includes('- '));
    assert.ok(!out.includes('```'));
    assert.ok(out.includes('south slope'));
  });

  it('removes assistant-speak and sign-offs but keeps the substance', () => {
    const t =
      "As an AI, I don't have feelings, but here's what I found: Eric wants it Friday. I hope this helps! Let me know if you need anything else.";
    const out = stripAssistantSpeak(t);
    assert.ok(!/as an ai/i.test(out));
    assert.ok(!/hope this helps/i.test(out));
    assert.ok(!/let me know/i.test(out));
    assert.ok(out.includes('Eric wants it Friday'));
  });

  it('splits a long reply into a few bubbles on sentence breaks and caps the count', () => {
    const long = Array.from(
      { length: 12 },
      (_, i) => `Sentence number ${i + 1} is here and it has some length to it.`,
    ).join(' ');
    const bubbles = shapeForText(long, {
      ...DEFAULT_TEXT_STYLE,
      maxBubbleChars: 120,
      maxBubbles: 3,
    });
    assert.equal(bubbles.length, 3);
    assert.ok(bubbles[0]!.length <= 120);
    assert.ok(bubbles[0]!.endsWith('.'));
    assert.ok(bubbles.join(' ').includes('Sentence number 12'), 'nothing dropped');
  });

  it('leaves a short human reply alone', () => {
    assert.deepEqual(shapeForText('Got it.'), ['Got it.']);
    assert.deepEqual(shapeForText('Yes, you are free at 3.'), ['Yes, you are free at 3.']);
  });

  it('paragraphs become separate bubbles', () => {
    const b = shapeForText('First thing.\n\nSecond thing, unrelated.');
    assert.deepEqual(b, ['First thing.', 'Second thing, unrelated.']);
  });

  it('disabled policy passes text through untouched', () => {
    const raw = '## Keep\n- this';
    assert.deepEqual(shapeForText(raw, { ...DEFAULT_TEXT_STYLE, enabled: false }), [raw]);
  });

  it('human delay is proportional and capped', () => {
    assert.equal(humanDelayMs('hi'), 16);
    assert.equal(humanDelayMs('x'.repeat(10_000)), 2000);
    assert.equal(humanDelayMs('anything', { ...DEFAULT_TEXT_STYLE, enabled: false }), 0);
  });

  it('the prompt rule forbids the chatbot tells', () => {
    assert.match(TEXT_STYLE_RULES, /No headers, no bullet lists/);
    assert.match(TEXT_STYLE_RULES, /No sign-offs/);
    assert.match(TEXT_STYLE_RULES, /As an AI/);
  });
});
