/**
 * The /vapi/webhook handler encodes end-of-call transcripts into CORTEX, so an
 * unauthenticated webhook is a memory-injection vector. verifyWebhook must fail
 * CLOSED: reject when no shared secret is configured, and constant-time compare
 * when one is. webhookUnauthenticated tells the gateway to warn at arm time.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from 'pino';
import { VapiChannel } from '../../src/channels/vapi.js';

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silent;
  },
} as unknown as Logger;

test('verifyWebhook fails CLOSED when no secret is configured', () => {
  const vapi = new VapiChannel({ logger: silent });
  assert.equal(vapi.verifyWebhook('anything'), false);
  assert.equal(vapi.verifyWebhook(undefined), false);
  assert.equal(vapi.webhookUnauthenticated, true);
});

test('verifyWebhook accepts the matching secret and rejects a wrong one', () => {
  const vapi = new VapiChannel({ logger: silent, webhookSecret: 's3cr3t-shared-value' });
  assert.equal(vapi.verifyWebhook('s3cr3t-shared-value'), true);
  assert.equal(vapi.verifyWebhook('s3cr3t-shared-valuX'), false);
  assert.equal(vapi.verifyWebhook(''), false);
  assert.equal(vapi.verifyWebhook(undefined), false);
  assert.equal(vapi.webhookUnauthenticated, false);
});

test('verifyWebhook is not fooled by a length mismatch (no timingSafeEqual throw)', () => {
  const vapi = new VapiChannel({ logger: silent, webhookSecret: 'short' });
  // A candidate of a different length must simply return false, never throw —
  // the digest-based compare normalizes length before timingSafeEqual.
  assert.doesNotThrow(() => vapi.verifyWebhook('a-much-longer-candidate-secret'));
  assert.equal(vapi.verifyWebhook('a-much-longer-candidate-secret'), false);
});
