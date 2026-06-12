/**
 * Per-agent gateway process manager. Spawns `meridian gateway` (via the
 * repo's tsx against src, so behavior always matches the checkout) detached
 * with MERIDIAN_AGENT=<slug>, tracks pids in ~/.meridian/.builder/, and
 * health-polls the gateway's /health endpoint.
 *
 * Gateways bind 127.0.0.1 (runtime default) — local-only by design.
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { readAgentConfigRaw } from './agents';
import { agentRoot, builderStateDir, cliMain, meridianRepo, tsxBin } from './paths';
import type { GatewayStatus } from './types';

interface GatewayRecord {
  pid: number;
  port: number;
  startedAt: string;
}

type StateFile = Record<string, GatewayRecord>;

function statePath(): string {
  return join(builderStateDir(), 'gateways.json');
}

function readState(): StateFile {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as StateFile;
  } catch {
    return {};
  }
}

function writeState(state: StateFile): void {
  mkdirSync(builderStateDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function healthOk(port: number, timeoutMs = 1200): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Find a free loopback port, preferring `preferred` if open. */
export async function allocatePort(preferred?: number): Promise<number> {
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolveTry) => {
      const srv = createServer();
      srv.once('error', () => resolveTry(false));
      srv.listen({ host: '127.0.0.1', port }, () => {
        srv.close(() => resolveTry(true));
      });
    });
  const taken = new Set(Object.values(readState()).map((r) => r.port));
  if (preferred && !taken.has(preferred) && (await tryPort(preferred))) return preferred;
  for (let port = 18901; port < 18999; port++) {
    if (taken.has(port)) continue;
    if (await tryPort(port)) return port;
  }
  throw new Error('no free port in 18901-18999');
}

export function agentPort(slug: string): number | undefined {
  const rec = readState()[slug];
  if (rec) return rec.port;
  return readAgentConfigRaw(slug)?.channels?.gateway?.port;
}

export async function gatewayStatus(slug: string): Promise<GatewayStatus> {
  const rec = readState()[slug];
  if (!rec || !pidAlive(rec.pid)) return { state: 'stopped', port: agentPort(slug) };
  if (await healthOk(rec.port)) return { state: 'running', port: rec.port, pid: rec.pid };
  return { state: 'starting', port: rec.port, pid: rec.pid };
}

export interface StartResult {
  status: GatewayStatus;
  log: string;
}

export async function startGateway(slug: string, waitMs = 45_000): Promise<StartResult> {
  const logPath = join(agentRoot(slug), 'logs', 'builder-gateway.log');
  const current = await gatewayStatus(slug);
  if (current.state === 'running') return { status: current, log: logPath };

  const port = current.state === 'starting' && current.port
    ? current.port
    : await allocatePort(agentPort(slug));

  if (current.state === 'stopped') {
    mkdirSync(join(agentRoot(slug), 'logs'), { recursive: true });
    const logFd = openSync(logPath, 'a');
    const child = spawn(tsxBin(), [cliMain(), 'gateway', '--port', String(port)], {
      cwd: meridianRepo(),
      env: {
        ...process.env,
        MERIDIAN_AGENT: slug,
        NODE_OPTIONS: '--no-deprecation',
      },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    if (!child.pid) throw new Error('failed to spawn gateway process');
    const state = readState();
    state[slug] = { pid: child.pid, port, startedAt: new Date().toISOString() };
    writeState(state);
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await healthOk(port)) {
      return { status: { state: 'running', port, pid: readState()[slug]?.pid }, log: logPath };
    }
    const rec = readState()[slug];
    if (rec && !pidAlive(rec.pid)) {
      const state = readState();
      delete state[slug];
      writeState(state);
      throw new Error(`gateway for "${slug}" exited during boot — see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: { state: 'starting', port, pid: readState()[slug]?.pid }, log: logPath };
}

export async function stopGateway(slug: string): Promise<GatewayStatus> {
  const state = readState();
  const rec = state[slug];
  if (rec && pidAlive(rec.pid)) {
    try {
      process.kill(rec.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    // Give it a moment; escalate if the event loop block (`await new Promise`)
    // in gateway-cmd keeps it alive.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && pidAlive(rec.pid)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (pidAlive(rec.pid)) {
      try {
        process.kill(rec.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  delete state[slug];
  writeState(state);
  return { state: 'stopped', port: agentPort(slug) };
}

/** Used by the e2e check: confirm the tsx runner exists before first use. */
export function runnerAvailable(): boolean {
  if (!existsSync(tsxBin())) return false;
  const probe = spawnSync(tsxBin(), ['--version'], { timeout: 10_000 });
  return probe.status === 0;
}
