/**
 * iMessage over BlueBubbles (WS5c). Driven with recorded webhook shapes and an
 * injected fetch; no relay, no network. Covers the secret gate, own-message
 * echo, allowlist, attachment download, human bubbles with typing, reactions,
 * SMS fallback, and operator handle matching.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
  ImessageChannel,
  chatGuidForHandle,
  handleFromChatGuid,
  splitForImessage,
  verifyWebhookSecret,
  type FetchLike,
} from '../../src/channels/imessage.js';
import type { InboundMessage } from '../../src/channels/types.js';
import { resolveOperator } from '../../src/agent/operator.js';
import { makeConfig } from '../helpers/fixtures.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const SECRET = 'a-very-long-shared-secret-1234';

function relay(opts: { failSend?: boolean; attachmentBytes?: Buffer } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const ok = !(opts.failSend && url.includes('/message/text'));
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ status: 200 }),
      arrayBuffer: async () => {
        const b = opts.attachmentBytes ?? Buffer.from('');
        return new Uint8Array(b).buffer as ArrayBuffer;
      },
      text: async () => '',
    };
  };
  return { calls, fetchImpl };
}

function channel(
  r: ReturnType<typeof relay>,
  extra: Partial<ConstructorParameters<typeof ImessageChannel>[0]> = {},
) {
  const inbound: InboundMessage[] = [];
  const ch = new ImessageChannel({
    serverUrl: 'http://relay.local:1234',
    password: 'pw',
    webhookSecret: SECRET,
    logger: silent,
    fetchImpl: r.fetchImpl,
    sleep: async () => {},
    ...extra,
  });
  return { ch, inbound };
}

const event = (over: Record<string, unknown> = {}) => ({
  type: 'new-message',
  data: {
    guid: 'msg-1',
    text: 'hey are you there',
    isFromMe: false,
    handle: { address: '+13033329227', service: 'iMessage' },
    chats: [{ guid: 'iMessage;-;+13033329227' }],
    ...over,
  },
});

describe('imessage helpers', () => {
  it('secret check is exact, timing safe, and fails closed', () => {
    assert.equal(verifyWebhookSecret(SECRET, SECRET), true);
    assert.equal(verifyWebhookSecret(SECRET, 'nope'), false);
    assert.equal(verifyWebhookSecret(SECRET, undefined), false);
    assert.equal(verifyWebhookSecret('', ''), false);
  });
  it('chat guid round trips a handle', () => {
    assert.equal(chatGuidForHandle('+15551234567'), 'iMessage;-;+15551234567');
    assert.equal(handleFromChatGuid('SMS;-;+15551234567'), '+15551234567');
    assert.equal(handleFromChatGuid('garbage'), undefined);
  });
  it('splits only past the platform limit', () => {
    assert.deepEqual(splitForImessage('short'), ['short']);
    assert.ok(splitForImessage('x '.repeat(3000)).length > 1);
  });
  it('constructor refuses to run without a secret', () => {
    assert.throws(
      () =>
        new ImessageChannel({ serverUrl: 'x', password: 'p', webhookSecret: '', logger: silent }),
    );
  });
});

describe('imessage inbound', () => {
  it('runs the turn and replies as blue bubbles with typing between them', async () => {
    const r = relay();
    const { ch, inbound } = channel(r);
    ch.start(undefined, {
      onInbound: async (m) => {
        inbound.push(m);
        return "Yep, I'm here.\n\nWant the brief now or after your 3pm?";
      },
    });
    const res = ch.handleRequest(event());
    assert.equal(res.status, 200);
    await res.done;
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0]?.channel, 'imessage');
    assert.equal(inbound[0]?.from, '+13033329227');
    const sends = r.calls.filter((c) => c.url.includes('/message/text'));
    assert.equal(sends.length, 2, 'two bubbles');
    assert.equal((sends[0]?.body as { chatGuid: string }).chatGuid, 'iMessage;-;+13033329227');
    assert.equal((sends[0]?.body as { message: string }).message, "Yep, I'm here.");
    assert.ok(
      r.calls.some((c) => c.url.includes('/typing') && c.method === 'POST'),
      'typing before bubble two',
    );
    assert.ok(
      r.calls.every((c) => c.url.includes('password=pw')),
      'relay auth on every call',
    );
  });

  it('ignores its own echoes, non-message events, and empty messages', async () => {
    const r = relay();
    const { ch, inbound } = channel(r);
    ch.start(undefined, {
      onInbound: async (m) => {
        inbound.push(m);
        return 'x';
      },
    });
    assert.equal(ch.handleRequest(event({ isFromMe: true })).body.ignored, 'own message');
    assert.equal(ch.handleRequest({ type: 'typing-indicator' }).body.ignored, 'event type');
    assert.equal(ch.handleRequest(event({ text: '   ' })).body.ignored, 'empty');
    assert.equal(inbound.length, 0);
    assert.equal(r.calls.length, 0);
  });

  it('allowlist drops strangers before the turn', async () => {
    const r = relay();
    const { ch, inbound } = channel(r, { allowedHandles: ['+13033329227'] });
    ch.start(undefined, {
      onInbound: async (m) => {
        inbound.push(m);
        return 'x';
      },
    });
    const res = ch.handleRequest(
      event({ handle: { address: '+19995550000' }, chats: [{ guid: 'iMessage;-;+19995550000' }] }),
    );
    assert.equal(res.body.ignored, 'not allowlisted');
    assert.equal(inbound.length, 0);
  });

  it('downloads an attachment into the media dir and tells the model where it is', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake');
    const r = relay({ attachmentBytes: bytes });
    const mediaDir = mkdtempSync(join(tmpdir(), 'meridian-im-'));
    const { ch, inbound } = channel(r, { mediaDir });
    ch.start(undefined, {
      onInbound: async (m) => {
        inbound.push(m);
        return 'got it';
      },
    });
    const res = ch.handleRequest(
      event({
        text: '',
        attachments: [
          {
            guid: 'att-1',
            mimeType: 'application/pdf',
            transferName: 'survey.pdf',
            totalBytes: bytes.length,
          },
        ],
      }),
    );
    await res.done;
    const meta = inbound[0]?.meta as { attachments?: Array<{ path: string }> };
    assert.equal(meta.attachments?.length, 1);
    assert.ok(existsSync(meta.attachments![0]!.path));
    assert.ok(inbound[0]?.text.includes('survey.pdf'));
    assert.ok(r.calls.some((c) => c.url.includes('/attachment/att-1/download')));
  });

  it('falls back to SMS when the relay cannot deliver to a phone handle', async () => {
    const r = relay({ failSend: true });
    const smsSent: Array<[string, string]> = [];
    const { ch } = channel(r, {
      smsFallback: {
        send: async (to, text) => {
          smsSent.push([to, text]);
        },
      },
    });
    ch.start(undefined, { onInbound: async () => 'Reply over the fallback.' });
    await ch.handleRequest(event()).done;
    assert.equal(smsSent.length, 1);
    assert.equal(smsSent[0]?.[0], '+13033329227');
    assert.match(smsSent[0]?.[1] ?? '', /fallback/);
  });

  it('send() accepts a bare handle or a chat guid, and react() posts a tapback', async () => {
    const r = relay();
    const { ch } = channel(r);
    await ch.send({ channel: 'imessage', to: '+13033329227', text: 'Morning brief: two things.' });
    const lastText = r.calls.filter((c) => c.url.includes('/message/text')).at(-1);
    assert.equal((lastText?.body as { chatGuid: string }).chatGuid, 'iMessage;-;+13033329227');
    assert.equal(await ch.react('iMessage;-;+13033329227', 'msg-1', 'love'), true);
    assert.equal((r.calls.at(-1)?.body as { reaction: string }).reaction, 'love');
  });

  it('relay probe records health for /health', async () => {
    const r = relay();
    const { ch } = channel(r);
    assert.equal(ch.relayHealth().checkedAt, null);
    assert.equal(await ch.probeRelay(), true);
    assert.equal(ch.relayHealth().ok, true);
  });
});

describe('imessage operator resolution', () => {
  it('matches the operator by phone (normalized) or email (case-folded), never mixed', () => {
    const config = makeConfig({
      operator: { id: 'rez', channels: { imessage: ['+1 (303) 332-9227', 'Rez@Example.com'] } },
    });
    assert.equal(resolveOperator(config, 'imessage', '+13033329227').source, 'config');
    assert.equal(resolveOperator(config, 'imessage', 'rez@example.com').source, 'config');
    assert.equal(resolveOperator(config, 'imessage', '+19995550000').source, 'unknown');
    assert.equal(resolveOperator(config, 'imessage', 'someone@example.com').source, 'unknown');
  });
});
