import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { LoopPairingStore, registerLoopPairingRoute } from '../../src/gateway/loop-pairing.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

describe('Loop one-time agent pairing', () => {
  it('redeems once, stores only hashes, and authenticates only the issued device token', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'loop-pairing-')), 'state.json');
    const store = new LoopPairingStore(path);
    const issued = store.issuePairingCode();
    const token = store.redeem(issued.code.toLowerCase(), '11111111-1111-4111-8111-111111111111');
    assert.ok(token);
    assert.equal(store.redeem(issued.code, '22222222-2222-4222-8222-222222222222'), null);
    assert.equal(store.authenticateDeviceToken(token!), true);
    assert.equal(store.authenticateDeviceToken(`${token}x`), false);
    const disk = readFileSync(path, 'utf8');
    assert.doesNotMatch(disk, new RegExp(issued.code.replaceAll('-', ''), 'i'));
    assert.doesNotMatch(disk, new RegExp(token!));
  });

  it('rejects invalid installations and unsafe TTLs', () => {
    const store = new LoopPairingStore(
      join(mkdtempSync(join(tmpdir(), 'loop-pairing-')), 'state.json'),
    );
    const issued = store.issuePairingCode();
    assert.equal(store.redeem(issued.code, 'not-a-uuid'), null);
    assert.throws(() => store.issuePairingCode(1), /TTL/);
  });

  it('preserves the protected state file mode across atomic rewrites', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'loop-pairing-')), 'state.json');
    const store = new LoopPairingStore(path);
    store.issuePairingCode();
    chmodSync(path, 0o660);
    store.issuePairingCode();
    assert.equal(lstatSync(path).mode & 0o777, 0o660);
  });

  it('revokes only the scoped device and remains idempotent without storing its token', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'loop-pairing-')), 'state.json');
    const store = new LoopPairingStore(path);
    const firstCode = store.issuePairingCode();
    const first = store.redeem(firstCode.code, '11111111-1111-4111-8111-111111111111');
    const secondCode = store.issuePairingCode();
    const second = store.redeem(secondCode.code, '22222222-2222-4222-8222-222222222222');
    assert.ok(first);
    assert.ok(second);

    assert.equal(store.revokeDeviceToken(first), 'revoked');
    assert.equal(store.authenticateDeviceToken(first), false);
    assert.equal(store.authenticateDeviceToken(second), true);
    const afterFirst = readFileSync(path);
    assert.doesNotMatch(afterFirst.toString('utf8'), new RegExp(first));

    assert.equal(store.revokeDeviceToken(first), 'already-revoked');
    assert.deepEqual(readFileSync(path), afterFirst);
    assert.equal(
      store.revokeDeviceToken('unknown-capability-that-was-never-issued-123456'),
      'unauthorized',
    );
    assert.deepEqual(readFileSync(path), afterFirst);
  });

  it('serves authenticated no-body DELETE with generic fail-closed errors', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'loop-pairing-')), 'state.json');
    const store = new LoopPairingStore(path);
    const issued = store.issuePairingCode();
    const token = store.redeem(issued.code, '11111111-1111-4111-8111-111111111111');
    assert.ok(token);
    const app = Fastify({ logger: false });
    registerLoopPairingRoute(app, {
      store,
      publicBaseURL: 'https://loop.example.test',
      agentSlug: 'arlo',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('gateway did not bind');
    const base = `http://127.0.0.1:${address.port}`;

    for (const expected of [204, 204]) {
      const response = await fetch(`${base}/v1/loop/pairings/current`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, expected);
      assert.equal(await response.text(), '');
    }
    for (const authorization of [
      undefined,
      'Bearer unknown-capability-that-was-never-issued-123456',
      'Bearer malformed',
    ]) {
      const response = await fetch(`${base}/v1/loop/pairings/current`, {
        method: 'DELETE',
        headers: authorization ? { authorization } : undefined,
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
  });
});
