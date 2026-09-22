import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { MeridianHome } from '../config/home.js';

export type AutonomyOutcome =
  | 'running'
  | 'success'
  | 'degraded'
  | 'skipped'
  | 'shadow'
  | 'awaiting_approval'
  | 'failed'
  | 'dead_letter';

export interface AutonomyRun {
  runId: string;
  job: string;
  scheduledAt: string;
  startedAt: string;
  finishedAt?: string;
  leaseUntil: string;
  attempt: number;
  outcome: AutonomyOutcome;
  reason?: string;
  outputDigest?: string;
  metadata?: Record<string, unknown>;
}

interface JobState {
  nextScheduledAt?: string;
  lease?: { runId: string; until: string; ownerId?: string };
  lastNotification?: { digest: string; at: string };
  consecutiveFailures: number;
  runs: AutonomyRun[];
}

interface ControlPlaneState {
  version: 1;
  jobs: Record<string, JobState>;
}

export interface BeginRunResult {
  acquired: boolean;
  run?: AutonomyRun;
  reason?: 'duplicate' | 'lease_active';
}

const MAX_RUNS_PER_JOB = 100;

export class AutonomyControlPlane {
  readonly statePath: string;
  private readonly lockPath: string;
  private readonly instanceId = `runtime_${randomUUID()}`;

  constructor(home: MeridianHome, statePath?: string) {
    this.statePath = statePath ?? join(home.layer('AUTOMATIONS'), '.runtime', 'control-plane.json');
    this.lockPath = `${this.statePath}.lock`;
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    if (!existsSync(this.statePath)) this.atomicWrite({ version: 1, jobs: {} });
  }

  static digest(value: unknown): string {
    return createHash('sha256')
      .update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
      .digest('hex');
  }

  begin(job: string, scheduledAt: Date, leaseMs: number, now = new Date()): BeginRunResult {
    return this.mutate((state) => {
      const current = this.job(state, job);
      const schedule = scheduledAt.toISOString();
      const duplicate = current.runs.find(
        (run) => run.scheduledAt === schedule && run.outcome !== 'dead_letter',
      );
      if (duplicate) return { acquired: false, reason: 'duplicate' };
      if (current.lease && current.lease.until > now.toISOString()) {
        return { acquired: false, reason: 'lease_active' };
      }
      if (current.lease) this.abandonExpiredRun(current, now);
      const run: AutonomyRun = {
        runId: `auto_${createHash('sha256').update(`${job}\0${schedule}`).digest('hex').slice(0, 24)}`,
        job,
        scheduledAt: schedule,
        startedAt: now.toISOString(),
        leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)).toISOString(),
        attempt: 1,
        outcome: 'running',
      };
      current.lease = { runId: run.runId, until: run.leaseUntil, ownerId: this.instanceId };
      current.runs.push(run);
      this.trim(current);
      return { acquired: true, run: { ...run } };
    });
  }

  finish(
    job: string,
    runId: string,
    outcome: Exclude<AutonomyOutcome, 'running'>,
    detail: { reason?: string; output?: unknown; metadata?: Record<string, unknown> } = {},
    now = new Date(),
  ): AutonomyRun {
    return this.mutate((state) => {
      const current = this.job(state, job);
      const run = current.runs.find((candidate) => candidate.runId === runId);
      if (!run) throw new Error(`unknown autonomy run '${runId}' for '${job}'`);
      if (run.outcome !== 'running') return { ...run };
      run.outcome = outcome;
      run.finishedAt = now.toISOString();
      run.reason = detail.reason;
      run.outputDigest =
        detail.output === undefined ? undefined : AutonomyControlPlane.digest(detail.output);
      run.metadata = detail.metadata;
      if (current.lease?.runId === runId) delete current.lease;
      current.consecutiveFailures =
        outcome === 'failed' || outcome === 'dead_letter' ? current.consecutiveFailures + 1 : 0;
      return { ...run };
    });
  }

  setNextScheduledAt(job: string, next: Date | null): void {
    this.mutate((state) => {
      const current = this.job(state, job);
      if (next) current.nextScheduledAt = next.toISOString();
      else delete current.nextScheduledAt;
    });
  }

  getNextScheduledAt(job: string): Date | null {
    const value = this.snapshot().jobs[job]?.nextScheduledAt;
    return value ? new Date(value) : null;
  }

  recoverExpired(now = new Date()): AutonomyRun[] {
    return this.mutate((state) => {
      const recovered: AutonomyRun[] = [];
      for (const current of Object.values(state.jobs)) {
        if (
          current.lease &&
          (current.lease.ownerId !== this.instanceId || current.lease.until <= now.toISOString())
        ) {
          const run = this.abandonExpiredRun(current, now);
          if (run) recovered.push({ ...run });
        }
      }
      return recovered;
    });
  }

  notificationAllowed(job: string, output: unknown, cooldownMs: number, now = new Date()): boolean {
    const digest = AutonomyControlPlane.digest(output);
    const previous = this.snapshot().jobs[job]?.lastNotification;
    return !(
      previous?.digest === digest && now.getTime() - new Date(previous.at).getTime() < cooldownMs
    );
  }

  recordNotification(job: string, output: unknown, now = new Date()): void {
    const digest = AutonomyControlPlane.digest(output);
    this.mutate((state) => {
      this.job(state, job).lastNotification = { digest, at: now.toISOString() };
    });
  }

  /** Compatibility helper for callers that perform no fallible delivery. */
  shouldNotify(job: string, output: unknown, cooldownMs: number, now = new Date()): boolean {
    if (!this.notificationAllowed(job, output, cooldownMs, now)) return false;
    this.recordNotification(job, output, now);
    return true;
  }

  runs(job: string): AutonomyRun[] {
    return (this.snapshot().jobs[job]?.runs ?? []).map((run) => ({ ...run }));
  }

  snapshot(): ControlPlaneState {
    return this.read();
  }

  private abandonExpiredRun(current: JobState, now: Date): AutonomyRun | undefined {
    const run = current.runs.find((candidate) => candidate.runId === current.lease?.runId);
    if (run?.outcome === 'running') {
      run.outcome = 'dead_letter';
      run.finishedAt = now.toISOString();
      run.reason =
        current.lease?.ownerId !== this.instanceId
          ? 'runtime restarted before a terminal outcome was recorded'
          : 'lease expired before a terminal outcome was recorded';
      current.consecutiveFailures++;
    }
    delete current.lease;
    return run;
  }

  private job(state: ControlPlaneState, name: string): JobState {
    const existing = state.jobs[name];
    if (existing) return existing;
    const created = { consecutiveFailures: 0, runs: [] };
    state.jobs[name] = created;
    return created;
  }

  private trim(job: JobState): void {
    if (job.runs.length > MAX_RUNS_PER_JOB) job.runs.splice(0, job.runs.length - MAX_RUNS_PER_JOB);
  }

  private read(): ControlPlaneState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as ControlPlaneState;
      if (parsed.version !== 1 || !parsed.jobs)
        throw new Error('unsupported autonomy state schema');
      return parsed;
    } catch (error) {
      throw new Error(`autonomy control-plane state is unreadable: ${this.statePath}`, {
        cause: error,
      });
    }
  }

  private mutate<T>(fn: (state: ControlPlaneState) => T): T {
    const fd = this.acquireLock();
    try {
      const state = this.read();
      const result = fn(state);
      this.atomicWrite(state);
      return result;
    } finally {
      closeSync(fd);
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* already released */
      }
    }
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
        return fd;
      } catch (error) {
        // A process can die between lock creation and cleanup. Reclaim only a
        // clearly stale, tiny critical-section lock; a live lock still fails
        // closed rather than permitting concurrent state writers.
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > 30_000) {
            unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          /* lock disappeared between checks */
        }
        throw new Error(`autonomy control-plane lock is busy: ${this.lockPath}`, { cause: error });
      }
    }
    throw new Error(`autonomy control-plane lock could not be acquired: ${this.lockPath}`);
  }

  private atomicWrite(state: ControlPlaneState): void {
    const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}
