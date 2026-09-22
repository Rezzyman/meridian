import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { FastifyInstance } from 'fastify';

export const LOOP_PAIRING_REQUEST_SCHEMA = 'aterna.loop.pairing.request.v1' as const;
export const LOOP_PAIRING_REPLY_SCHEMA = 'aterna.loop.pairing.reply.v1' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_BYTES = 32;
const MAX_CODES = 20;
const MAX_DEVICES = 50;
const MAX_REVOCATIONS = 1_000;

interface PairingCodeRecord {
  digest: string;
  expiresAt: string;
}
interface LoopDeviceRecord {
  tokenDigest: string;
  installationId: string;
  createdAt: string;
  lastUsedAt?: string;
}
interface LoopRevocationRecord {
  tokenDigest: string;
  revokedAt: string;
}
interface PairingState {
  schemaVersion: 'aterna.loop.pairing.state.v1';
  codes: PairingCodeRecord[];
  devices: LoopDeviceRecord[];
  revocations: LoopRevocationRecord[];
}

export type LoopPairingRevocationResult = 'revoked' | 'already-revoked' | 'unauthorized';

function digest(kind: 'code' | 'token', value: string): string {
  return createHash('sha256')
    .update(`aterna-loop-${kind}:`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}
function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function emptyState(): PairingState {
  return { schemaVersion: 'aterna.loop.pairing.state.v1', codes: [], devices: [], revocations: [] };
}

export class LoopPairingStore {
  constructor(private readonly path: string) {}

  issuePairingCode(ttlMs = 10 * 60_000): { code: string; expiresAt: string } {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
      throw new Error('pairing TTL must be between 1 and 60 minutes');
    }
    const raw = randomBytes(15).toString('hex').toUpperCase();
    const code = raw.match(/.{1,5}/g)!.join('-');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const state = this.read();
    const now = Date.now();
    state.codes = state.codes
      .filter((item) => Date.parse(item.expiresAt) > now)
      .slice(-(MAX_CODES - 1));
    state.codes.push({ digest: digest('code', normalizedCode(code)), expiresAt });
    this.write(state);
    return { code, expiresAt };
  }

  redeem(pairingCode: string, installationId: string): string | null {
    if (!UUID.test(installationId)) return null;
    const candidate = digest('code', normalizedCode(pairingCode));
    const state = this.read();
    const now = Date.now();
    const index = state.codes.findIndex(
      (item) => Date.parse(item.expiresAt) > now && sameDigest(item.digest, candidate),
    );
    if (index === -1) return null;
    state.codes.splice(index, 1);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    state.devices = state.devices
      .filter((item) => item.installationId.toLowerCase() !== installationId.toLowerCase())
      .slice(-(MAX_DEVICES - 1));
    state.devices.push({
      tokenDigest: digest('token', token),
      installationId: installationId.toLowerCase(),
      createdAt: new Date(now).toISOString(),
    });
    this.write(state);
    return token;
  }

  authenticateDeviceToken(token: string): boolean {
    if (token.length < 40 || token.length > 128) return false;
    const candidate = digest('token', token);
    return this.read().devices.some((item) => sameDigest(item.tokenDigest, candidate));
  }

  revokeDeviceToken(token: string): LoopPairingRevocationResult {
    if (token.length < 40 || token.length > 128) return 'unauthorized';
    const candidate = digest('token', token);
    const state = this.read();
    const active = state.devices.some((item) => sameDigest(item.tokenDigest, candidate));
    if (!active) {
      return state.revocations.some((item) => sameDigest(item.tokenDigest, candidate))
        ? 'already-revoked'
        : 'unauthorized';
    }
    state.devices = state.devices.filter((item) => !sameDigest(item.tokenDigest, candidate));
    state.revocations = state.revocations
      .filter((item) => !sameDigest(item.tokenDigest, candidate))
      .slice(-(MAX_REVOCATIONS - 1));
    state.revocations.push({ tokenDigest: candidate, revokedAt: new Date().toISOString() });
    this.write(state);
    return 'revoked';
  }

  private read(): PairingState {
    if (!existsSync(this.path)) return emptyState();
    if (!lstatSync(this.path).isFile()) throw new Error('Loop pairing state is not a regular file');
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PairingState>;
    if (
      parsed.schemaVersion !== 'aterna.loop.pairing.state.v1' ||
      !Array.isArray(parsed.codes) ||
      !Array.isArray(parsed.devices) ||
      parsed.codes.length > MAX_CODES ||
      parsed.devices.length > MAX_DEVICES ||
      (parsed.revocations !== undefined &&
        (!Array.isArray(parsed.revocations) || parsed.revocations.length > MAX_REVOCATIONS))
    ) {
      throw new Error('invalid Loop pairing state');
    }
    parsed.revocations ??= [];
    return parsed as PairingState;
  }

  private write(state: PairingState): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    const previous = existsSync(this.path) ? lstatSync(this.path) : undefined;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (previous) {
      if (typeof process.getuid !== 'function' || process.getuid() === 0) {
        chownSync(temporary, previous.uid, previous.gid);
      }
      chmodSync(temporary, previous.mode & 0o770);
    }
    renameSync(temporary, this.path);
  }
}

export function registerLoopPairingRoute(
  app: FastifyInstance,
  opts: {
    store: LoopPairingStore;
    publicBaseURL: string;
    agentSlug: string;
    agentDisplayName?: string;
  },
): void {
  const hits = new Map<string, { count: number; since: number }>();
  app.post<{ Body: unknown }>('/v1/loop/pairings/redeem', async (req, reply) => {
    const now = Date.now();
    const hit = hits.get(req.ip);
    if (!hit || now - hit.since >= 60_000) hits.set(req.ip, { count: 1, since: now });
    else if (++hit.count > 10) {
      reply.code(429);
      return { error: 'rate limited' };
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      reply.code(400);
      return { error: 'invalid pairing request' };
    }
    const body = req.body as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(',') !== 'installationId,pairingCode,schemaVersion' ||
      body.schemaVersion !== LOOP_PAIRING_REQUEST_SCHEMA ||
      typeof body.pairingCode !== 'string' ||
      typeof body.installationId !== 'string' ||
      !UUID.test(body.installationId)
    ) {
      reply.code(400);
      return { error: 'invalid pairing request' };
    }
    const deviceToken = opts.store.redeem(body.pairingCode, body.installationId);
    if (!deviceToken) {
      reply.code(401);
      return { error: 'invalid or expired pairing code' };
    }
    return {
      schemaVersion: LOOP_PAIRING_REPLY_SCHEMA,
      agentSlug: opts.agentSlug,
      agentDisplayName:
        opts.agentDisplayName ?? opts.agentSlug.charAt(0).toUpperCase() + opts.agentSlug.slice(1),
      gatewayBaseURL: opts.publicBaseURL,
      deviceToken,
    };
  });
  app.delete<{ Body: unknown; Headers: { authorization?: string } }>(
    '/v1/loop/pairings/current',
    async (req, reply) => {
      const match =
        typeof req.headers.authorization === 'string'
          ? /^Bearer[\t ]+(\S{40,128})$/i.exec(req.headers.authorization)
          : null;
      if (!match) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      if (req.body !== undefined) {
        reply.code(400);
        return { error: 'invalid revocation request' };
      }
      const outcome = opts.store.revokeDeviceToken(match[1]);
      if (outcome === 'unauthorized') {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      return reply.code(204).send();
    },
  );
}
