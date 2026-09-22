import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { createOpsAlerter } from '../../src/ops/alerts.js';

const quiet = { warn() {}, error() {}, info() {}, debug() {} } as unknown as Logger;

describe('ops alert sink (WS5)', () => {
  it('sends to the ops chat with a prefix and rate limits per key', async () => {
    const sent: Array<[string, string]> = [];
    let t = 0;
    const ops = createOpsAlerter({
      logger: quiet,
      chatId: '999',
      send: async (c, m) => {
        sent.push([c, m]);
      },
      cooldownMs: 1000,
      now: () => t,
    });
    assert.equal(ops.destination, 'telegram');
    assert.equal(await ops.alert('silent:brief', 'brief is quiet'), true);
    assert.equal(
      await ops.alert('silent:brief', 'brief is quiet'),
      false,
      'same key inside cooldown',
    );
    t = 2000;
    assert.equal(await ops.alert('silent:brief', 'brief is quiet'), true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.[0], '999');
    assert.match(sent[0]?.[1] ?? '', /^\[meridian ops\]/);
  });
  it('is log-only without a chat id and never throws', async () => {
    const ops = createOpsAlerter({ logger: quiet });
    assert.equal(ops.destination, 'log');
    assert.equal(await ops.alert('k', 'x'), true);
  });
  it('a failed delivery is reported false, not thrown', async () => {
    const ops = createOpsAlerter({
      logger: quiet,
      chatId: '1',
      send: async () => {
        throw new Error('telegram down');
      },
    });
    assert.equal(await ops.alert('k', 'x'), false);
  });
});
