import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installCrashHandlers, settle } from '../../src/gateway/crash-safety.js';
import type { Logger } from 'pino';

function fakeLogger() {
  const lines: Array<{ level: string; obj: Record<string, unknown> }> = [];
  const mk = (level: string) => (obj: Record<string, unknown>) => {
    lines.push({ level, obj });
  };
  const logger = {
    error: mk('error'),
    fatal: mk('fatal'),
    warn: mk('warn'),
    info: mk('info'),
    debug: mk('debug'),
  } as unknown as Logger;
  return { logger, lines };
}

function fakeProcess() {
  const em = new EventEmitter();
  const exits: number[] = [];
  return {
    target: Object.assign(em, {
      exit: (code: number) => {
        exits.push(code);
      },
    }),
    exits,
  };
}

describe('crash safety', () => {
  it('an unhandled rejection is logged and the process keeps running', () => {
    const { logger, lines } = fakeLogger();
    const { target, exits } = fakeProcess();
    assert.equal(installCrashHandlers(logger, target, { agentId: 'arlo' }), true);
    target.emit('unhandledRejection', new Error('background turn died'));
    assert.equal(exits.length, 0);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, 'error');
    assert.equal(lines[0]?.obj.agentId, 'arlo');
    assert.match(String((lines[0]?.obj.err as Error).message), /background turn died/);
  });

  it('an uncaught exception is logged at fatal and exits 1 for the supervisor', () => {
    const { logger, lines } = fakeLogger();
    const { target, exits } = fakeProcess();
    installCrashHandlers(logger, target, { agentId: 'arlo' });
    target.emit('uncaughtException', new Error('boom'));
    assert.deepEqual(exits, [1]);
    assert.equal(lines[0]?.level, 'fatal');
  });

  it('is idempotent per process object', () => {
    const { logger } = fakeLogger();
    const { target } = fakeProcess();
    assert.equal(installCrashHandlers(logger, target), true);
    assert.equal(installCrashHandlers(logger, target), false);
    assert.equal(target.listenerCount('unhandledRejection'), 1);
  });

  it('settle() logs a rejected background turn with its route and never throws', async () => {
    const { logger, lines } = fakeLogger();
    const failing = Promise.reject(new Error('turn failed after reply'));
    settle(failing, logger, { route: '/slack/events', channel: 'slack' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.obj.route, '/slack/events');
    assert.equal(lines[0]?.obj.channel, 'slack');
  });

  it('settle() is silent on success', async () => {
    const { logger, lines } = fakeLogger();
    settle(Promise.resolve('ok'), logger, { route: '/sms' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(lines.length, 0);
  });
});
