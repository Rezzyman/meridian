import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeridianHome } from '../../src/config/home.js';
import { SessionStore } from '../../src/session/store.js';
import { dispatchChannelCommand, isChannelCommand } from '../../src/gateway/slash.js';
import { makeConfig } from '../helpers/fixtures.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function store(): SessionStore {
  const root = mkdtempSync(join(tmpdir(), 'meridian-slash-'));
  roots.push(root);
  const agentRoot = join(root, 'arlo');
  const home = {
    root,
    agentSlug: 'arlo',
    agentRoot,
    configPath: join(agentRoot, 'config.yaml'),
    envPath: join(agentRoot, '.env'),
    vaultPath: join(agentRoot, 'vault.enc'),
    layer: (name: string) => join(agentRoot, name),
    sessions: join(agentRoot, 'sessions'),
    logs: join(agentRoot, 'logs'),
    checkpoints: join(agentRoot, 'checkpoints'),
    stateDb: join(agentRoot, 'state.db'),
  } as MeridianHome;
  return new SessionStore(home);
}

describe('slash commands on chat channels (WS3)', () => {
  const config = makeConfig({
    operator: { id: 'atanasio', name: 'Rez', channels: { telegram: ['123'] } },
  });

  it('recognizes the channel-safe command set and nothing else', () => {
    assert.equal(isChannelCommand('/approve automation:morning-brief'), true);
    assert.equal(isChannelCommand('/reject draft:abc'), true);
    assert.equal(isChannelCommand('/automations'), true);
    assert.equal(isChannelCommand('/model gpt'), false);
    assert.equal(isChannelCommand('approve this please'), false);
  });

  it('/approve automation:<name> mints a one-use operator-scoped grant the manager will consume', async () => {
    const s = store();
    const out = await dispatchChannelCommand('/approve automation:morning-brief', {
      config,
      store: s,
      sessionId: 'telegram:123',
    });
    assert.match(out ?? '', /approved one use of automation:morning-brief/);
    const digest = s.digestActionArgs({ anything: true });
    assert.equal(s.consumeApproval('op:atanasio', 'automation:morning-brief', digest), true);
    assert.equal(
      s.consumeApproval('op:atanasio', 'automation:morning-brief', digest),
      false,
      'one use only',
    );
  });

  it('/approve draft without a manager says so instead of pretending', async () => {
    const out = await dispatchChannelCommand('/approve draft:abc', { config, sessionId: 's' });
    assert.match(out ?? '', /not running/);
  });

  it('/reject needs a draft id', async () => {
    const out = await dispatchChannelCommand('/reject', { config, sessionId: 's' });
    assert.match(out ?? '', /usage/);
  });

  it('/help lists the commands and prose is left to the model', async () => {
    assert.match(
      (await dispatchChannelCommand('/help', { config, sessionId: 's' })) ?? '',
      /approve draft/,
    );
    assert.equal(
      await dispatchChannelCommand('hello there', { config, sessionId: 's' }),
      undefined,
    );
  });
});
