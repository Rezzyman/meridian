/**
 * gog binary resolver — manages the bundled gogcli (Google Workspace CLI).
 *
 * Why this exists: Meridian ships batteries-included. Every Meridian agent
 * gets Google Workspace access out of the box without the operator needing
 * to `brew install gogcli` or `go install` anything. This module locates the
 * right gogcli binary for the current platform, downloading it on first use
 * from steipete/gogcli's GitHub Releases, verifying its SHA-256 against the
 * official checksums file.
 *
 * Resolution order (first hit wins):
 *   1. process.env.MERIDIAN_GOG_BIN          — explicit override
 *   2. ~/.meridian/bin/gog-<version>         — Meridian-managed binary
 *   3. (auto-download into #2 from GitHub Releases)
 *   4. (last-ditch) `which gog` on PATH       — dev convenience on machines
 *                                              that already have it installed
 *
 * License: gogcli is MIT. We link to GitHub Releases at runtime instead of
 * vendoring binaries inside the repo, which keeps the meridian repo lean
 * and avoids redistribution-license edge cases on Windows builds.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export const GOG_VERSION = '0.14.0';

const RELEASE_BASE = `https://github.com/steipete/gogcli/releases/download/v${GOG_VERSION}`;

// SHA-256 checksums from the official checksums.txt for v0.14.0.
// Verified 2026-05-01 against
//   https://github.com/steipete/gogcli/releases/download/v0.14.0/checksums.txt
const CHECKSUMS: Record<string, string> = {
  'darwin-amd64': 'f8a0dd555e8d92354666c87f55019a372b537c362c00b84acf28b351ecdad61f',
  'darwin-arm64': 'a89f87edd73ea0f9fb139ee4bc423094073df749e4a62192aa51420f2f64663a',
  'linux-amd64': 'b2adaa503627aa56d9186cf1047a790aa15f8dd18522480dd4ff14060c9dd21b',
  'linux-arm64': '28eab80326328d4bcbead32ae16b4e66ed9661376d251d60e38b85989b7ca07b',
};

function platformKey(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!platform) {
    throw new Error(`unsupported platform for gog: ${process.platform}. only darwin and linux are supported.`);
  }
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  if (!arch) {
    throw new Error(`unsupported architecture for gog: ${process.arch}. only arm64 and amd64 are supported.`);
  }
  return `${platform}-${arch}`;
}

function meridianBinDir(): string {
  return join(homedir(), '.meridian', 'bin');
}

function managedBinaryPath(): string {
  return join(meridianBinDir(), `gog-${GOG_VERSION}`);
}

async function fetchBinary(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`gog download failed: ${url} → ${res.status} ${res.statusText}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}`;
  const sink = createWriteStream(tmp);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, sink);
  // Move tmp → dest atomically so a failed mid-write never leaves a half file.
  const { renameSync } = await import('node:fs');
  renameSync(tmp, dest);
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const data = readFileSync(path);
  hash.update(data);
  return hash.digest('hex');
}

async function extractGogFromTarball(tarballPath: string, outBinaryPath: string): Promise<void> {
  // Extract the tarball into a fresh tempdir and copy out the gog binary.
  // The system `tar` command is universally present on macOS and Linux. We
  // avoid streaming through stdout because of subtle pipe-flush races that
  // can leave the destination file truncated when the binary is large.
  const list = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  if (list.status !== 0) {
    throw new Error(`tar list failed: ${list.stderr}`);
  }
  const entries = list.stdout.split('\n').filter(Boolean);
  const binaryEntry = entries.find((e) => e === 'gog' || e === 'gogcli' || /\/gog$/.test(e) || /\/gogcli$/.test(e));
  if (!binaryEntry) {
    throw new Error(`gog binary not found inside ${tarballPath}: ${entries.join(', ')}`);
  }
  const { mkdtempSync, copyFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const stagingDir = mkdtempSync(join(tmpdir(), 'meridian-gog-extract-'));
  try {
    const ex = spawnSync('tar', ['-xzf', tarballPath, '-C', stagingDir, binaryEntry], { encoding: 'utf8' });
    if (ex.status !== 0) {
      throw new Error(`tar extract failed: ${ex.stderr}`);
    }
    mkdirSync(dirname(outBinaryPath), { recursive: true });
    copyFileSync(join(stagingDir, binaryEntry), outBinaryPath);
    chmodSync(outBinaryPath, 0o755);
  } finally {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

let resolvedPath: string | null = null;

/**
 * Resolve (and lazily download) the gog binary path. Returns an absolute
 * path to an executable gog binary appropriate for this platform.
 *
 * Throws if the platform is unsupported, the download fails, or the
 * checksum doesn't match.
 */
export async function resolveGog(opts: { allowPathFallback?: boolean } = {}): Promise<string> {
  if (resolvedPath) return resolvedPath;

  // 1. explicit override
  const fromEnv = process.env.MERIDIAN_GOG_BIN;
  if (fromEnv && existsSync(fromEnv)) {
    resolvedPath = fromEnv;
    return fromEnv;
  }

  // 2. previously-downloaded managed binary
  const managed = managedBinaryPath();
  if (existsSync(managed)) {
    resolvedPath = managed;
    return managed;
  }

  // 3. download from GitHub releases
  try {
    const key = platformKey();
    const expectedSha = CHECKSUMS[key];
    if (!expectedSha) throw new Error(`no checksum on file for ${key}`);
    const tarballName = `gogcli_${GOG_VERSION}_${key.replace('-', '_')}.tar.gz`;
    const url = `${RELEASE_BASE}/${tarballName}`;
    const tarballPath = join(meridianBinDir(), `.cache.${tarballName}`);
    await fetchBinary(url, tarballPath);
    const actualSha = sha256File(tarballPath);
    if (actualSha !== expectedSha) {
      throw new Error(`checksum mismatch for ${tarballName}: expected ${expectedSha}, got ${actualSha}`);
    }
    await extractGogFromTarball(tarballPath, managed);
    // macOS Sequoia tags downloaded binaries with com.apple.provenance and
    // refuses to run them unsigned (SIGKILL 137). Clear extended attributes
    // and ad-hoc sign so Gatekeeper accepts the binary. No-op on Linux.
    if (process.platform === 'darwin') {
      spawnSync('xattr', ['-c', managed]);
      const sign = spawnSync('codesign', ['--force', '--sign', '-', managed], { encoding: 'utf8' });
      if (sign.status !== 0) {
        throw new Error(`ad-hoc codesign failed: ${sign.stderr}`);
      }
    }
    // Validate it runs.
    const v = spawnSync(managed, ['--version'], { encoding: 'utf8' });
    if (v.status !== 0) {
      throw new Error(`extracted gog binary failed to run (exit ${v.status}): ${v.stderr ?? '(no stderr)'}`);
    }
    resolvedPath = managed;
    return managed;
  } catch (downloadErr) {
    // 4. dev-convenience PATH fallback (default off; opt-in via flag)
    if (opts.allowPathFallback) {
      const which = spawnSync('which', ['gog'], { encoding: 'utf8' });
      const onPath = which.stdout.trim();
      if (which.status === 0 && onPath) {
        resolvedPath = onPath;
        return onPath;
      }
    }
    throw downloadErr;
  }
}

export interface GogRunOptions {
  /** OAuth client bucket — Meridian uses one bucket per agent for token isolation */
  client: string;
  /** Mailbox / account email, when the subcommand needs one */
  account?: string;
  /** Force JSON output for parsing */
  json?: boolean;
  /** Args after the subcommand, e.g. ['gmail', 'search', 'in:inbox'] */
  args: string[];
  /** Timeout in ms (default 60s) */
  timeoutMs?: number;
  /** Capture stderr in the result instead of throwing on non-zero exit */
  captureStderr?: boolean;
}

export interface GogRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a gog command. Resolves the binary first (downloading if needed),
 * spawns gog with the given args plus --client / --account / --json flags
 * as appropriate. Returns stdout/stderr/exitCode.
 */
export async function runGog(opts: GogRunOptions): Promise<GogRunResult> {
  const bin = await resolveGog({ allowPathFallback: true });
  const args = [...opts.args];
  args.push('--client', opts.client);
  if (opts.account) args.push('--account', opts.account);
  if (opts.json !== false) args.push('--json');
  // Always non-interactive when called from tools — fail fast instead of
  // hanging on a prompt the model can't answer.
  args.push('--no-input');
  return await new Promise<GogRunResult>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`gog timed out after ${opts.timeoutMs ?? 60_000}ms`));
    }, opts.timeoutMs ?? 60_000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Convenience: run gog and parse stdout as JSON. Throws on non-zero exit.
 */
export async function runGogJson<T = unknown>(opts: GogRunOptions): Promise<T> {
  const result = await runGog(opts);
  if (result.exitCode !== 0) {
    throw new Error(`gog ${opts.args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  if (!result.stdout.trim()) return undefined as unknown as T;
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new Error(`gog returned non-JSON output: ${(err as Error).message}\n${result.stdout.slice(0, 500)}`);
  }
}

/**
 * List authorized accounts in a given client bucket. Returns the parsed
 * `gog auth list` output filtered to the client.
 */
export async function listAccounts(client: string): Promise<Array<{ email: string; client: string; scopes: string; expires?: string; type: string }>> {
  const bin = await resolveGog({ allowPathFallback: true });
  // `gog auth list` is the unscoped form — list everything, filter ourselves
  // because --client filters by bucket but we want a top-level survey.
  const result = spawnSync(bin, ['auth', 'list', '--no-input'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`gog auth list failed: ${result.stderr}`);
  }
  const out: Array<{ email: string; client: string; scopes: string; expires?: string; type: string }> = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [email, clientName, scopes, expires, type] = parts;
    if (clientName !== client) continue;
    out.push({ email, client: clientName, scopes, expires, type });
  }
  return out;
}
