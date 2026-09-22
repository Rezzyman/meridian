/**
 * WS3: the safety config that used to be parsed and ignored now does things
 * an operator can see. Approval-gated runs tell the operator, draft runs land
 * in OUTBOX and wait for /approve, and trust graduation flips a job to direct
 * mode with a signed receipt.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MeridianHome } from '../../src/config/home.js';
import { AutomationManager } from '../../src/automations/manager.js';
import { SessionStore } from '../../src/session/store.js';
import {
  makeConfig,
  mockCortex,
  mockRouter,
  silentLogger,
  textModel,
} from '../helpers/fixtures.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(frontmatter: string) {
  const root = mkdtempSync(join(tmpdir(), 'meridian-ws3-'));
  roots.push(root);
  const agentRoot = join(root, 'arlo');
  mkdirSync(join(agentRoot, 'AUTOMATIONS'), { recursive: true });
  writeFileSync(
    join(agentRoot, 'AUTOMATIONS', 'test.cron'),
    `---\n${frontmatter}\n---\nProduce a useful result.\n`,
  );
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
  const config = makeConfig({
    operator: { id: 'atanasio', name: 'Rez', channels: { telegram: ['123'] } },
  });
  const sent: string[] = [];
  const channels = new Map([
    [
      'telegram',
      {
        name: 'telegram',
        start() {},
        stop() {},
        send: async (msg: { text: string }) => {
          sent.push(msg.text);
        },
      },
    ],
  ]);
  const store = new SessionStore(home);
  const m = new AutomationManager({
    home,
    config,
    cortex: mockCortex(),
    router: mockRouter(textModel('Morning brief: two items. Call Eric at ten.')),
    logger: silentLogger,
    systemBase: 'system',
    channels: channels as never,
    store,
  });
  return { home, config, sent, store, m };
}

const LIVE = 'autonomyMode: live\nactionTier: observe';

describe('approval gate tells the operator (WS3)', () => {
  it('an awaiting_approval run pushes a notice with the exact command', async () => {
    const f = fixture(
      `name: test\nschedule: "0 8 * * *"\n${LIVE}\nrequiresApproval: true\nmode: direct`,
    );
    f.m.start();
    const r = await f.m.fire('test', new Date('2026-09-22T14:00:00Z'));
    f.m.stop();
    assert.equal(r?.outcome, 'awaiting_approval');
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0] ?? '', /\/approve automation:test/);
  });
  it('the notice is rate limited so a stuck job does not spam', async () => {
    const f = fixture(
      `name: test\nschedule: "0 8 * * *"\n${LIVE}\nrequiresApproval: true\nmode: direct`,
    );
    f.m.start();
    await f.m.fire('test', new Date('2026-09-22T14:00:00Z'));
    await f.m.fire('test', new Date('2026-09-22T15:00:00Z'));
    f.m.stop();
    assert.equal(f.sent.length, 1);
  });
});

describe('draft mode (WS3)', () => {
  it('writes OUTBOX, previews to the operator, delivers only on /approve, keeps the file on /reject', async () => {
    const f = fixture(
      `name: test\nschedule: "0 8 * * *"\n${LIVE}\nrequiresApproval: false\nmode: draft`,
    );
    f.m.start();
    const r = await f.m.fire('test', new Date('2026-09-22T14:00:00Z'));
    assert.equal(r?.outcome, 'success');
    assert.deepEqual(r?.pushedTo, ['outbox']);
    const outbox = join(f.home.agentRoot, 'OUTBOX', 'test');
    assert.ok(existsSync(outbox));
    assert.equal(readdirSync(outbox).length, 1);
    assert.equal(f.sent.length, 1, 'one preview notice');
    assert.match(f.sent[0] ?? '', /\/approve draft:/);
    const [draft] = f.m.listDrafts();
    assert.ok(draft);
    assert.equal(draft.name, 'test');
    assert.match(draft.preview, /Morning brief/);

    const delivered = await f.m.deliverDraft(draft.id);
    assert.equal(delivered.ok, true);
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1] ?? '', /Call Eric at ten/);
    assert.equal(f.m.listDrafts().length, 0, 'delivered drafts are no longer pending');
    assert.equal((await f.m.deliverDraft(draft.id)).ok, false, 'cannot deliver twice');

    const r2 = await f.m.fire('test', new Date('2026-09-23T14:00:00Z'));
    assert.equal(r2?.outcome, 'success');
    const [second] = f.m.listDrafts();
    assert.ok(second);
    assert.equal(f.m.rejectDraft(second.id).ok, true);
    assert.equal(f.m.listDrafts().length, 0);
    assert.equal(readdirSync(outbox).length, 2, 'rejected drafts are kept, marked, never deleted');
    f.m.stop();
  });
});

describe('trust graduation (WS3)', () => {
  it('after N consecutive approved runs the job stops asking and a signed receipt records why', async () => {
    const f = fixture(
      `name: test\nschedule: "0 8 * * *"\n${LIVE}\nrequiresApproval: true\nmode: direct\ntrustGraduation: 2`,
    );
    f.m.start();
    const grant = () => f.store.grantApproval('op:atanasio', 'automation:test', 5);
    grant();
    assert.equal((await f.m.fire('test', new Date('2026-09-22T14:00:00Z')))?.outcome, 'success');
    grant();
    assert.equal((await f.m.fire('test', new Date('2026-09-23T14:00:00Z')))?.outcome, 'success');
    const st = f.m.status().find((s) => s.name === 'test');
    assert.ok(st?.graduatedAt, 'graduated after two approved runs');
    // Third run: no grant, still runs.
    assert.equal((await f.m.fire('test', new Date('2026-09-24T14:00:00Z')))?.outcome, 'success');
    const receipts = f.store.listActionReceipts('automation:test', 50);
    const grad = receipts.find((r) => r.toolName === 'automation.graduate');
    assert.ok(grad, 'graduation receipt recorded');
    assert.equal(f.store.verifyActionReceipt(grad!), true);
    assert.ok(
      f.sent.some((t) => /earned direct mode/.test(t)),
      'operator told',
    );
    f.m.stop();
  });
  it('a gate stop resets the streak', async () => {
    const f = fixture(
      `name: test\nschedule: "0 8 * * *"\n${LIVE}\nrequiresApproval: true\nmode: direct\ntrustGraduation: 2`,
    );
    f.m.start();
    f.store.grantApproval('op:atanasio', 'automation:test', 5);
    await f.m.fire('test', new Date('2026-09-22T14:00:00Z'));
    await f.m.fire('test', new Date('2026-09-23T14:00:00Z')); // no grant -> awaiting
    f.store.grantApproval('op:atanasio', 'automation:test', 5);
    await f.m.fire('test', new Date('2026-09-24T14:00:00Z'));
    assert.equal(f.m.status()[0]?.graduatedAt, null);
    f.m.stop();
  });
});
