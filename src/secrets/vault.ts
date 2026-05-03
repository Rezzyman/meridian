/**
 * Encrypted vault — per-agent secrets store.
 *
 * AES-256-GCM with a key derived from MERIDIAN_VAULT_KEY in the agent's .env.
 * Vault contents are stored at `~/.meridian/<agent>/vault.enc`. Each entry is
 * a key-value pair; values may be strings, JSON-serialisable objects, or
 * blobs (OAuth tokens, passphrase hashes, API keys for skills, etc.).
 *
 * Why this design (vs simple .env.secrets):
 *   - File-at-rest is encrypted, so vault.enc can be backed up safely
 *   - Easy to rotate vault contents without rotating the agent's triad
 *   - Clean API for skills that need credentials (vault.get / vault.set)
 *   - Foundational for v1.x master-passphrase + keychain upgrades
 *
 * Why MERIDIAN_VAULT_KEY in .env (vs interactive master passphrase):
 *   - systemd autostart with no human in the loop
 *   - .env is already chmod 600 and protected
 *   - One key per agent, not a global one (per-agent isolation principle)
 *   - Upgrade path to user-supplied master + libsecret keeps this API stable
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// Vault file layout (binary, base64 wrapper for env-friendly storage):
//   1 byte   version (0x01)
//   16 bytes salt
//   12 bytes iv (GCM nonce)
//   16 bytes auth tag
//   N bytes  ciphertext (UTF-8 JSON)
const VAULT_VERSION = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface VaultPayload {
  version: number;
  updatedAt: string;
  entries: Record<string, unknown>;
}

function deriveKey(rawKey: string, salt: Buffer): Buffer {
  // scrypt KDF — costs ~30ms per derive on modern hardware, still gives
  // ~10^9 brute-force ops for a leaked .env. N=2^14 sits comfortably under
  // Node's default 32MB scrypt memory ceiling; we also pass explicit
  // maxmem=64MB so future params changes don't hit "memory limit exceeded".
  return scryptSync(rawKey, salt, KEY_LEN, {
    N: 1 << 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export class Vault {
  private payload: VaultPayload = {
    version: VAULT_VERSION,
    updatedAt: new Date().toISOString(),
    entries: {},
  };

  constructor(
    private readonly path: string,
    private readonly rawKey: string,
  ) {
    if (!rawKey || rawKey.length < 32) {
      throw new Error(
        'MERIDIAN_VAULT_KEY missing or too short (need 32+ chars). ' +
          'Generate one with: openssl rand -hex 32',
      );
    }
    if (existsSync(path)) this.load();
  }

  /**
   * Fast-path init for fresh agents — generate a new MERIDIAN_VAULT_KEY
   * and append it to the agent's .env if not present. Returns the key.
   * Idempotent: if a key is already there, returns it unchanged.
   */
  static ensureEnvKey(envPath: string): string {
    if (!existsSync(envPath)) {
      throw new Error(`agent .env not found at ${envPath} — run meridian init first`);
    }
    const env = readFileSync(envPath, 'utf8');
    const match = env.match(/^MERIDIAN_VAULT_KEY=(.+)$/m);
    if (match) return match[1]!.trim();
    const key = randomBytes(32).toString('hex');
    writeFileSync(envPath, env.trimEnd() + `\nMERIDIAN_VAULT_KEY=${key}\n`, { mode: 0o600 });
    return key;
  }

  private load(): void {
    const wrapped = readFileSync(this.path, 'utf8').trim();
    const buf = Buffer.from(wrapped, 'base64');
    if (buf.length < 1 + SALT_LEN + IV_LEN + TAG_LEN + 1) {
      throw new Error('vault file truncated or corrupt');
    }
    if (buf[0] !== VAULT_VERSION) {
      throw new Error(`vault version mismatch (got ${buf[0]}, want ${VAULT_VERSION})`);
    }
    const salt = buf.subarray(1, 1 + SALT_LEN);
    const iv = buf.subarray(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN);
    const tag = buf.subarray(1 + SALT_LEN + IV_LEN, 1 + SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(1 + SALT_LEN + IV_LEN + TAG_LEN);
    const key = deriveKey(this.rawKey, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plaintext: string;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
      throw new Error(
        `vault decryption failed: ${(err as Error).message}. ` +
          'MERIDIAN_VAULT_KEY may have changed since this vault was written.',
      );
    }
    this.payload = JSON.parse(plaintext) as VaultPayload;
  }

  private persist(): void {
    this.payload.updatedAt = new Date().toISOString();
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = deriveKey(this.rawKey, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.payload), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const buf = Buffer.concat([
      Buffer.from([VAULT_VERSION]),
      salt,
      iv,
      tag,
      ciphertext,
    ]);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, buf.toString('base64') + '\n', { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best-effort on systems without chmod */
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.payload.entries[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.payload.entries[key] = value;
    this.persist();
  }

  delete(key: string): void {
    delete this.payload.entries[key];
    this.persist();
  }

  has(key: string): boolean {
    return key in this.payload.entries;
  }

  list(): string[] {
    return Object.keys(this.payload.entries);
  }

  /**
   * Bulk update — useful when a skill's setup walkthrough captures multiple
   * fields at once (OAuth refresh+access tokens + scopes + expiry).
   */
  setMany(entries: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(entries)) {
      this.payload.entries[k] = v;
    }
    this.persist();
  }
}

/**
 * Convenience: open the vault for the active agent. Reads MERIDIAN_VAULT_KEY
 * from the agent's .env (auto-generates one if missing) and opens (or
 * creates) `~/.meridian/<agent>/vault.enc`.
 */
export function openAgentVault(args: { envPath: string; vaultPath: string }): Vault {
  const key = Vault.ensureEnvKey(args.envPath);
  return new Vault(args.vaultPath, key);
}
