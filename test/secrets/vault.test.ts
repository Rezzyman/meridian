/**
 * Vault tests — AES-256-GCM secrets store (src/secrets/vault.ts).
 *
 * Everything lives in a per-run tmpdir; no network, no ~/.meridian. scrypt is
 * ~30ms per derive (one per persist, one per load), so tests are kept lean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, openAgentVault } from '../../src/secrets/vault.js';

const KEY = 'test-vault-key-0123456789abcdef-0123456789abcdef'; // 48 chars
const OTHER_KEY = 'other-vault-key-0123456789abcdef-0123456789abc'; // 47 chars

const root = mkdtempSync(join(tmpdir(), 'meridian-vault-test-'));
let n = 0;
function vaultPath(): string {
  return join(root, `case-${n++}`, 'vault.enc');
}

// ─── CRUD round-trip ─────────────────────────────────────────────────────────

test('set/get/has/list/delete round-trip on one instance', () => {
  const vault = new Vault(vaultPath(), KEY);
  vault.set('api_key', 'sk-secret-123');
  vault.set('oauth', { access: 'a', refresh: 'r', expiresAt: 1234567890 });

  assert.equal(vault.get<string>('api_key'), 'sk-secret-123');
  assert.deepEqual(vault.get('oauth'), { access: 'a', refresh: 'r', expiresAt: 1234567890 });
  assert.equal(vault.has('api_key'), true);
  assert.deepEqual(vault.list().sort(), ['api_key', 'oauth']);

  vault.delete('api_key');
  assert.equal(vault.has('api_key'), false);
  assert.equal(vault.get('api_key'), undefined);
  assert.deepEqual(vault.list(), ['oauth']);
});

test('setMany stores multiple entries and they survive reload', () => {
  const path = vaultPath();
  const vault = new Vault(path, KEY);
  vault.setMany({ a: '1', b: { nested: true }, c: [1, 2, 3] });

  const reopened = new Vault(path, KEY);
  assert.equal(reopened.get('a'), '1');
  assert.deepEqual(reopened.get('b'), { nested: true });
  assert.deepEqual(reopened.get('c'), [1, 2, 3]);
  assert.deepEqual(reopened.list().sort(), ['a', 'b', 'c']);
});

test('persistence: a second Vault on same path+key reads what the first wrote', () => {
  const path = vaultPath();
  new Vault(path, KEY).set('token', 'persisted-value');

  const reopened = new Vault(path, KEY);
  assert.equal(reopened.get('token'), 'persisted-value');
});

// ─── Empty / missing-key behavior ────────────────────────────────────────────

test('empty vault: list() is [], get/has report absence', () => {
  const vault = new Vault(vaultPath(), KEY);
  assert.deepEqual(vault.list(), []);
  assert.equal(vault.get('nope'), undefined);
  assert.equal(vault.has('nope'), false);
});

test('delete of a missing key is a no-op (but still persists the file)', () => {
  const path = vaultPath();
  const vault = new Vault(path, KEY);
  vault.set('keep', 'me');

  assert.doesNotThrow(() => vault.delete('never-existed'));
  assert.deepEqual(vault.list(), ['keep']);

  // delete() always calls persist(), so the file must still load cleanly
  const reopened = new Vault(path, KEY);
  assert.equal(reopened.get('keep'), 'me');
});

// ─── Key validation / wrong key ──────────────────────────────────────────────

test('constructor rejects empty or short keys with guidance', () => {
  assert.throws(() => new Vault(vaultPath(), ''), /missing or too short/);
  assert.throws(() => new Vault(vaultPath(), 'short-key'), /need 32\+ chars/);
});

test('wrong key fails to decrypt with a clear message', () => {
  const path = vaultPath();
  new Vault(path, KEY).set('secret', 'value');

  assert.throws(
    () => new Vault(path, OTHER_KEY),
    /vault decryption failed: .*MERIDIAN_VAULT_KEY may have changed/s,
  );
});

// ─── Corrupt files ───────────────────────────────────────────────────────────

test('truncated vault file throws a clear error', () => {
  const path = join(root, 'truncated.enc');
  // 4 bytes — well under the 46-byte minimum header
  writeFileSync(path, `${Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64')}\n`);
  assert.throws(() => new Vault(path, KEY), /vault file truncated or corrupt/);
});

test('garbage base64 with valid version byte fails decryption cleanly', () => {
  const path = join(root, 'garbage.enc');
  const garbage = Buffer.concat([Buffer.from([0x01]), randomBytes(64)]);
  writeFileSync(path, `${garbage.toString('base64')}\n`);
  assert.throws(() => new Vault(path, KEY), /vault decryption failed/);
});

test('unknown version byte throws a version mismatch error', () => {
  const path = join(root, 'badversion.enc');
  const bad = Buffer.concat([Buffer.from([0x7f]), randomBytes(64)]);
  writeFileSync(path, `${bad.toString('base64')}\n`);
  assert.throws(() => new Vault(path, KEY), /vault version mismatch \(got 127, want 1\)/);
});

// ─── File permissions ────────────────────────────────────────────────────────

test('vault file is mode 0600 after save', () => {
  const path = vaultPath();
  new Vault(path, KEY).set('k', 'v');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

// ─── Vault.ensureEnvKey ──────────────────────────────────────────────────────

test('ensureEnvKey throws when .env does not exist', () => {
  assert.throws(
    () => Vault.ensureEnvKey(join(root, 'no-such-dir', '.env')),
    /agent \.env not found .*run meridian init first/,
  );
});

test('ensureEnvKey appends a fresh hex key, preserves content, keeps mode 0600', () => {
  const envPath = join(root, 'fresh.env');
  writeFileSync(envPath, 'MERIDIAN_AGENT=test-agent\nOPENAI_API_KEY=sk-dummy\n', { mode: 0o600 });

  const key = Vault.ensureEnvKey(envPath);
  assert.match(key, /^[0-9a-f]{64}$/);

  const content = readFileSync(envPath, 'utf8');
  assert.match(content, /^MERIDIAN_AGENT=test-agent$/m);
  assert.match(content, /^OPENAI_API_KEY=sk-dummy$/m);
  assert.match(content, new RegExp(`^MERIDIAN_VAULT_KEY=${key}$`, 'm'));
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
});

test('ensureEnvKey is idempotent: second call returns same key, file unchanged', () => {
  const envPath = join(root, 'idempotent.env');
  writeFileSync(envPath, 'FOO=bar\n', { mode: 0o600 });

  const first = Vault.ensureEnvKey(envPath);
  const afterFirst = readFileSync(envPath, 'utf8');

  const second = Vault.ensureEnvKey(envPath);
  assert.equal(second, first);
  assert.equal(readFileSync(envPath, 'utf8'), afterFirst);
  assert.equal(afterFirst.match(/^MERIDIAN_VAULT_KEY=/gm)?.length, 1);
});

test('ensureEnvKey returns a pre-existing key trimmed, without rewriting', () => {
  const envPath = join(root, 'preexisting.env');
  const existing = 'f'.repeat(64);
  const original = `MERIDIAN_VAULT_KEY=${existing} \nFOO=bar\n`;
  writeFileSync(envPath, original, { mode: 0o600 });

  assert.equal(Vault.ensureEnvKey(envPath), existing);
  assert.equal(readFileSync(envPath, 'utf8'), original);
});

// ─── openAgentVault ──────────────────────────────────────────────────────────

test('openAgentVault generates the env key and round-trips across opens', () => {
  const envPath = join(root, 'agent.env');
  writeFileSync(envPath, 'MERIDIAN_AGENT=test-agent\n', { mode: 0o600 });
  const path = join(root, 'agent-vault', 'vault.enc');

  openAgentVault({ envPath, vaultPath: path }).set('telegram_token', 'tg-123');

  const reopened = openAgentVault({ envPath, vaultPath: path });
  assert.equal(reopened.get('telegram_token'), 'tg-123');
});
