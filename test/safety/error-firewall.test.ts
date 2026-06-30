import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLeaky,
  redactInternalDisclosure,
  sanitizeOutbound,
  sanitizeUserFacingError,
  GENERIC_HICCUP_MESSAGE,
  ProviderChainError,
} from '../../src/safety/error-firewall.js';

test('isLeaky catches the real-incident leak strings', () => {
  for (const s of [
    'unauthorized: unauthorized: AuthenticateToken authentication failed', // 2026-06-30 Groq 401
    'HTTP 402: Insufficient credits. Add more using https://openrouter.ai/settings/credits', // Zeebo
    "Error code: 402 - {'message':'Insufficient credits'}",
    'API provider returned a billing error — your API key has run out of credits', // Stormy
    'All providers failed. openrouter/x: 401 | anthropic/y: insufficient balance',
  ]) {
    assert.equal(isLeaky(s), true, `should flag as leaky: ${s}`);
  }
});

test('isLeaky is false on ordinary replies', () => {
  assert.equal(isLeaky('I booked the inspection and emailed Lori the summary.'), false);
  assert.equal(isLeaky(''), false);
});

test('redactInternalDisclosure neutralizes our providers/runtime', () => {
  const r = redactInternalDisclosure('the VAPI call system itself is working');
  assert.equal(r.text, 'our system call system itself is working');
  assert.equal(r.redacted, true);

  const r2 = redactInternalDisclosure('We route through OpenRouter and Anthropic, with a Groq fallback.');
  assert.equal(r2.text, 'We route through our system and our system, with our system fallback.');
  assert.equal(r2.redacted, true);
});

test('redactInternalDisclosure neutralizes our team names', () => {
  assert.equal(
    redactInternalDisclosure('something AJ needs to touch').text,
    'something our team needs to touch',
  );
  assert.equal(
    redactInternalDisclosure('I will flag this to @rezzyman and Rez can fix it').text,
    'I will flag this to our team and our team can fix it',
  );
});

test('redactInternalDisclosure does NOT touch client-owned systems (no false positives)', () => {
  const safe = 'I emailed Lori and checked your 8x8 line and Stripe — all good.';
  const r = redactInternalDisclosure(safe);
  assert.equal(r.text, safe);
  assert.equal(r.redacted, false);
});

test('sanitizeOutbound: leaky → generic, disclosure → redacted, clean → unchanged', () => {
  assert.equal(sanitizeOutbound('HTTP 402: Insufficient credits'), GENERIC_HICCUP_MESSAGE);
  assert.equal(sanitizeOutbound('the VAPI system is up'), 'our system system is up');
  const clean = 'Your appointment is confirmed for Tuesday at 9am.';
  assert.equal(sanitizeOutbound(clean), clean);
});

test('sanitizeUserFacingError replaces leaky text, passes clean text', () => {
  assert.equal(sanitizeUserFacingError('http 402: insufficient credits'), GENERIC_HICCUP_MESSAGE);
  assert.equal(sanitizeUserFacingError('on it'), 'on it');
});

test('ProviderChainError message is client-safe; raw detail kept internal', () => {
  const e = new ProviderChainError('openrouter/x: 401 unauthorized; anthropic/y: 402');
  assert.ok(e instanceof Error);
  assert.equal(e.message, GENERIC_HICCUP_MESSAGE);
  assert.equal(isLeaky(e.message), false);
  assert.match(e.internalDetail, /401 unauthorized/);
});
