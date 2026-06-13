/**
 * Matrix channel. parseSyncMessages is the pure core (which /sync events become
 * agent turns); pollOnce + send are driven through an injected fetch so the
 * whole round-trip is exercised offline — no homeserver, no token.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import {
  type FetchLike,
  MatrixChannel,
  type MatrixSyncResponse,
  parseSyncMessages,
} from '../../src/channels/matrix.js';
import type { InboundMessage } from '../../src/channels/types.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const SELF = '@bot:server';

const syncWith = (o: Record<string, unknown>): MatrixSyncResponse => o as MatrixSyncResponse;

const userMsg: MatrixSyncResponse = {
  next_batch: 's2',
  rooms: {
    join: {
      '!room:server': {
        timeline: {
          events: [
            { type: 'm.room.message', sender: '@alice:server', event_id: '$1', content: { msgtype: 'm.text', body: 'hello bot' } },
          ],
        },
      },
    },
  },
};

describe('parseSyncMessages', () => {
  it('extracts m.text messages from joined rooms', () => {
    const msgs = parseSyncMessages(userMsg, SELF, new Set());
    assert.deepEqual(msgs, [{ roomId: '!room:server', eventId: '$1', sender: '@alice:server', text: 'hello bot' }]);
  });

  it('ignores the bot’s own messages', () => {
    const own = syncWith({
      rooms: { join: { '!r:s': { timeline: { events: [
        { type: 'm.room.message', sender: SELF, event_id: '$x', content: { msgtype: 'm.text', body: 'I am the bot' } },
      ] } } } },
    });
    assert.deepEqual(parseSyncMessages(own, SELF, new Set()), []);
  });

  it('ignores non-text message types (images, notices)', () => {
    const nonText = syncWith({
      rooms: { join: { '!r:s': { timeline: { events: [
        { type: 'm.room.message', sender: '@a:s', event_id: '$i', content: { msgtype: 'm.image', body: 'pic.png' } },
        { type: 'm.room.member', sender: '@a:s', event_id: '$j', content: {} },
      ] } } } },
    });
    assert.deepEqual(parseSyncMessages(nonText, SELF, new Set()), []);
  });

  it('honors a room allowlist', () => {
    const two = syncWith({
      rooms: { join: {
        '!allowed:s': { timeline: { events: [{ type: 'm.room.message', sender: '@a:s', event_id: '$1', content: { msgtype: 'm.text', body: 'in' } }] } },
        '!other:s': { timeline: { events: [{ type: 'm.room.message', sender: '@a:s', event_id: '$2', content: { msgtype: 'm.text', body: 'out' } }] } },
      } },
    });
    const msgs = parseSyncMessages(two, SELF, new Set(['!allowed:s']));
    assert.deepEqual(msgs.map((m) => m.text), ['in']);
  });

  it('returns [] for an empty sync', () => {
    assert.deepEqual(parseSyncMessages({}, SELF, new Set()), []);
    assert.deepEqual(parseSyncMessages({ rooms: { join: {} } }, SELF, new Set()), []);
  });
});

function harness(sync: MatrixSyncResponse) {
  const sends: Array<{ url: string; body: { msgtype: string; body: string } }> = [];
  let syncCalls = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes('/sync')) {
      syncCalls++;
      return { ok: true, status: 200, json: async () => sync };
    }
    if (url.includes('/send/')) {
      sends.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true, status: 200, json: async () => ({ event_id: '$sent' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const ch = new MatrixChannel({
    homeserverUrl: 'https://hs.example/',
    accessToken: 'tok',
    userId: SELF,
    logger: log,
    fetchImpl,
  });
  return { ch, sends, syncCalls: () => syncCalls };
}

function setHandler(ch: MatrixChannel, fn: (m: InboundMessage) => Promise<string>): void {
  (ch as unknown as { handler: (m: InboundMessage) => Promise<string> }).handler = fn;
}

describe('MatrixChannel.pollOnce', () => {
  it('turns a room message into an agent turn and posts the reply', async () => {
    const { ch, sends } = harness(userMsg);
    const seen: InboundMessage[] = [];
    setHandler(ch, async (m) => {
      seen.push(m);
      return 'pong';
    });
    const next = await ch.pollOnce(undefined);
    assert.equal(next, 's2');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].channel, 'matrix');
    assert.equal(seen[0].text, 'hello bot');
    assert.equal(sends.length, 1);
    assert.match(sends[0].url, /\/rooms\/.+\/send\/m\.room\.message\//);
    assert.deepEqual(sends[0].body, { msgtype: 'm.text', body: 'pong' });
  });

  it('de-duplicates a repeated event across sync batches', async () => {
    const { ch, sends } = harness(userMsg);
    let calls = 0;
    setHandler(ch, async () => {
      calls++;
      return 'r';
    });
    await ch.pollOnce(undefined);
    await ch.pollOnce('s2'); // same event id $1 returned again
    assert.equal(calls, 1, 'handler should fire once for a repeated event id');
    assert.equal(sends.length, 1);
  });
});

describe('MatrixChannel.send', () => {
  it('PUTs an m.text message to the room', async () => {
    const { ch, sends } = harness({});
    await ch.send({ channel: 'matrix', to: '!room:server', text: 'direct send' });
    assert.equal(sends.length, 1);
    assert.ok(sends[0].url.includes('/_matrix/client/v3/rooms/'));
    assert.equal(sends[0].body.body, 'direct send');
    assert.equal(sends[0].body.msgtype, 'm.text');
  });
});
