/**
 * HeartbeatScheduler wiring + behavior.
 *
 * armHeartbeat() is the exact seam `meridian gateway` boots through
 * (src/cli/gateway-cmd.ts), mirroring the sentinel/automations lifecycle:
 * enabled config → constructed + started; disabled → never constructed.
 * beat() is the cron tick's action — it must run a REAL turn through the
 * injected Conversation (the gateway injects its operator-keyed turn()
 * facade), respect active hours, and trim the ack to ackMaxChars.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Conversation } from '../../src/agent/conversation.js';
import {
  HEARTBEAT_PROMPT,
  HeartbeatScheduler,
  armHeartbeat,
  intervalToCron,
  withinActiveHours,
} from '../../src/heartbeat/scheduler.js';
import { makeConfig, silentLogger } from '../helpers/fixtures.js';

/** Conversation stub that records every send, like mockCortex records calls. */
function stubConversation(reply = 'heartbeat ack body') {
  const sendCalls: string[] = [];
  const convo = {
    sessionId: 'sess-heartbeat',
    historyCount: 0,
    send: async (text: string) => {
      sendCalls.push(text);
      return {
        id: 't_hb',
        sessionId: 'sess-heartbeat',
        role: 'assistant' as const,
        content: reply,
        channel: 'gateway' as const,
        ts: new Date().toISOString(),
      };
    },
  } as unknown as Conversation;
  return { convo, sendCalls };
}

/** Heartbeat config through the real zod schema, like the gateway loads it. */
function makeHeartbeat(overrides: Record<string, unknown> = {}) {
  return makeConfig({ heartbeat: overrides }).heartbeat;
}

const ALL_DAY = { start: '00:00', end: '23:59' };

const schedulers: Array<HeartbeatScheduler | null> = [];
after(() => {
  for (const s of schedulers) s?.stop();
});

describe('gateway boot wiring (armHeartbeat)', () => {
  it('enabled config constructs AND starts the scheduler', () => {
    const { convo } = stubConversation();
    const hb = armHeartbeat({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: true, every: '30m', activeHours: ALL_DAY }),
      logger: silentLogger,
    });
    schedulers.push(hb);
    assert.ok(hb, 'enabled heartbeat returns a scheduler instance');
    assert.equal(hb.running, true, 'scheduler cron task is started at boot');
  });

  it('disabled config → scheduler is never constructed', () => {
    const { convo, sendCalls } = stubConversation();
    const hb = armHeartbeat({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: false }),
      logger: silentLogger,
    });
    assert.equal(hb, null, 'disabled heartbeat yields no scheduler');
    assert.equal(sendCalls.length, 0);
  });

  it('start() on a disabled scheduler schedules nothing (defense in depth)', () => {
    const { convo } = stubConversation();
    const hb = new HeartbeatScheduler({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: false }),
      logger: silentLogger,
    });
    hb.start();
    assert.equal(hb.running, false);
  });

  it('stop() tears the cron task down, mirroring sentinel/automations stop()', () => {
    const { convo } = stubConversation();
    const hb = armHeartbeat({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: true, activeHours: ALL_DAY }),
      logger: silentLogger,
    });
    assert.ok(hb);
    hb.stop();
    assert.equal(hb.running, false);
  });
});

describe('beat() — the cron tick action', () => {
  it('runs a real turn through the injected conversation with the heartbeat prompt', async () => {
    const { convo, sendCalls } = stubConversation();
    const acks: string[] = [];
    const hb = new HeartbeatScheduler({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: true, activeHours: ALL_DAY }),
      logger: silentLogger,
      onAck: (t) => acks.push(t),
    });
    const ran = await hb.beat(new Date());
    assert.equal(ran, true);
    assert.deepEqual(sendCalls, [HEARTBEAT_PROMPT]);
    assert.deepEqual(acks, ['heartbeat ack body']);
  });

  it('respects active hours: no turn outside the window', async () => {
    const { convo, sendCalls } = stubConversation();
    const hb = new HeartbeatScheduler({
      conversation: convo,
      heartbeat: makeHeartbeat({
        enabled: true,
        activeHours: { start: '09:00', end: '17:00' },
      }),
      logger: silentLogger,
    });
    const threeAm = new Date();
    threeAm.setHours(3, 0, 0, 0);
    assert.equal(await hb.beat(threeAm), false);
    assert.equal(sendCalls.length, 0);

    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    assert.equal(await hb.beat(noon), true);
    assert.equal(sendCalls.length, 1);
  });

  it('trims the ack to ackMaxChars', async () => {
    const { convo } = stubConversation('x'.repeat(600));
    const acks: string[] = [];
    const hb = new HeartbeatScheduler({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: true, activeHours: ALL_DAY, ackMaxChars: 100 }),
      logger: silentLogger,
      onAck: (t) => acks.push(t),
    });
    await hb.beat();
    assert.equal(acks[0]?.length, 100);
  });

  it('a failing turn is swallowed (beat returns false, no throw)', async () => {
    const convo = {
      send: async () => {
        throw new Error('provider down');
      },
    } as unknown as Conversation;
    const hb = new HeartbeatScheduler({
      conversation: convo,
      heartbeat: makeHeartbeat({ enabled: true, activeHours: ALL_DAY }),
      logger: silentLogger,
    });
    assert.equal(await hb.beat(), false);
  });

  it('scheduled cron task actually fires beat (1s interval, live timer)', async () => {
    const fired = new Promise<string>((resolve) => {
      const convo = {
        send: async (text: string) => {
          resolve(text);
          return { content: 'ok' };
        },
      } as unknown as Conversation;
      const hb = armHeartbeat({
        conversation: convo,
        heartbeat: makeHeartbeat({ enabled: true, every: '1s', activeHours: ALL_DAY }),
        logger: silentLogger,
      });
      schedulers.push(hb);
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('cron beat never fired within 3s')), 3000),
    );
    const prompt = await Promise.race([fired, timeout]);
    assert.equal(prompt, HEARTBEAT_PROMPT);
  });
});

describe('intervalToCron / withinActiveHours', () => {
  it("translates Hermes-style intervals ('30m', '2h', '1s', '1d')", () => {
    assert.equal(intervalToCron('30m'), '*/30 * * * *');
    assert.equal(intervalToCron('2h'), '0 */2 * * *');
    assert.equal(intervalToCron('1s'), '*/1 * * * * *');
    assert.equal(intervalToCron('1d'), '0 0 */1 * *');
  });

  it('falls back to every-2h on garbage input', () => {
    assert.equal(intervalToCron('whenever'), '0 */2 * * *');
  });

  it('active-hours window is inclusive at both edges', () => {
    const at = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    assert.equal(withinActiveHours(at(6, 0), '06:00', '23:30'), true);
    assert.equal(withinActiveHours(at(23, 30), '06:00', '23:30'), true);
    assert.equal(withinActiveHours(at(5, 59), '06:00', '23:30'), false);
    assert.equal(withinActiveHours(at(23, 31), '06:00', '23:30'), false);
  });
});
