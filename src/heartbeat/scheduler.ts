/** Evidence-driven heartbeat governed by the durable autonomy control plane. */

import { generateText } from 'ai';
import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import type { AgentConfig, Heartbeat } from '../config/schema.js';
import type { MeridianHome } from '../config/home.js';
import type { Logger } from 'pino';
import type { MemoryProvider } from '../memory/provider.js';
import type { ProviderRouter } from '../providers/router.js';
import { AutonomyControlPlane } from '../autonomy/control-plane.js';

export const HEARTBEAT_PROMPT = `Evaluate only the supplied evidence for anything stale, overdue, blocked, or materially actionable.
Return JSON only with this exact shape:
{"status":"quiet|actionable|degraded","confidence":0.0,"summary":"...","evidence":["..."],"suggestedAction":"..."}
Never invent missing evidence. Use degraded when the evidence source is unavailable or insufficient.`;

export interface HeartbeatAssessment {
  status: 'quiet' | 'actionable' | 'degraded';
  confidence: number;
  summary: string;
  evidence: string[];
  suggestedAction: string;
}

export function withinActiveHours(now: Date, start: string, end: string): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(start);
  const b = toMin(end);
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
}

export function intervalToCron(every: string): string {
  const m = /^(\d+)\s*([smhd])$/.exec(every.trim().toLowerCase());
  if (!m) return '0 */2 * * *';
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 's': return `*/${Math.max(1, Math.min(59, n))} * * * * *`;
    case 'm': return `*/${Math.max(1, Math.min(59, n))} * * * *`;
    case 'h': return `0 */${Math.max(1, Math.min(23, n))} * * *`;
    case 'd': return `0 0 */${Math.max(1, n)} * *`;
    default: return '0 */2 * * *';
  }
}

export function parseHeartbeatAssessment(text: string): HeartbeatAssessment {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('heartbeat model did not return JSON');
  const raw = JSON.parse(text.slice(start, end + 1)) as Partial<HeartbeatAssessment>;
  if (!['quiet', 'actionable', 'degraded'].includes(raw.status ?? '')) throw new Error('invalid heartbeat status');
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) throw new Error('invalid heartbeat confidence');
  if (typeof raw.summary !== 'string' || !Array.isArray(raw.evidence) || !raw.evidence.every((x) => typeof x === 'string')) {
    throw new Error('invalid heartbeat evidence');
  }
  return {
    status: raw.status as HeartbeatAssessment['status'],
    confidence: raw.confidence,
    summary: raw.summary,
    evidence: raw.evidence,
    suggestedAction: typeof raw.suggestedAction === 'string' ? raw.suggestedAction : '',
  };
}

export interface HeartbeatAssessorOptions {
  config: AgentConfig;
  cortex: MemoryProvider;
  router: ProviderRouter;
  systemBase: string;
  logger: Logger;
}

export function createHeartbeatAssessor(opts: HeartbeatAssessorOptions): () => Promise<HeartbeatAssessment> {
  return async () => {
    let context: string;
    try {
      const recalled = await Promise.race([
        opts.cortex.recall('current commitments deadlines blockers operational health and relationship follow-ups', {
          tokenBudget: 1200,
          sensitivityFilter: ['public', 'internal'],
          since: new Date(Date.now() - 21 * 24 * 3600 * 1000),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('heartbeat evidence timeout')), 10_000)),
      ]);
      context = recalled.context;
    } catch (error) {
      opts.logger.warn({ msg: 'heartbeat evidence unavailable', error });
      return { status: 'degraded', confidence: 1, summary: 'Heartbeat evidence source unavailable.', evidence: [], suggestedAction: 'Inspect CORTEX recall health.' };
    }
    const refs = [opts.config.heartbeat.model, ...opts.config.models.fallbacks].filter((v, i, a) => a.indexOf(v) === i);
    for (const ref of refs) {
      try {
        const provider = opts.router.resolve(ref);
        const result = await generateText({
          model: provider.model,
          system: `${opts.systemBase}\n\nYou are a read-only autonomy assessor. You have no tools and may not take actions.`,
          prompt: `${HEARTBEAT_PROMPT}\n\n<evidence>\n${context || '(no evidence returned)'}\n</evidence>`,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(60_000),
        });
        opts.router.reportSuccess(ref);
        return parseHeartbeatAssessment(result.text);
      } catch (error) {
        opts.router.reportFailure(ref);
        opts.logger.warn({ msg: 'heartbeat provider failed', ref, error });
      }
    }
    return { status: 'degraded', confidence: 1, summary: 'Heartbeat provider chain exhausted.', evidence: [], suggestedAction: 'Inspect provider availability.' };
  };
}

export interface HeartbeatSchedulerOptions {
  home: MeridianHome;
  heartbeat: Heartbeat;
  logger: Logger;
  assess: () => Promise<HeartbeatAssessment>;
  onAck?: (text: string) => undefined | boolean | Promise<undefined | boolean>;
  controlPlane?: AutonomyControlPlane;
}

export class HeartbeatScheduler {
  private task: ScheduledTask | null = null;
  private readonly controlPlane: AutonomyControlPlane;

  constructor(private opts: HeartbeatSchedulerOptions) {
    this.controlPlane = opts.controlPlane ?? new AutonomyControlPlane(opts.home);
  }

  get running(): boolean { return this.task !== null; }

  start(): void {
    if (!this.opts.heartbeat.enabled) {
      this.opts.logger.info({ msg: 'heartbeat disabled by config' });
      return;
    }
    for (const recovered of this.controlPlane.recoverExpired()) {
      this.opts.logger.error({ msg: 'heartbeat run recovered to dead letter', ...recovered });
    }
    const expr = intervalToCron(this.opts.heartbeat.every);
    this.task = cronSchedule(expr, () => { void this.beat(); });
    this.controlPlane.setNextScheduledAt('heartbeat', this.task.getNextRun());
    this.opts.logger.info({ msg: 'heartbeat scheduled', expr, every: this.opts.heartbeat.every, mode: this.opts.heartbeat.mode });
  }

  async beat(now = new Date()): Promise<boolean> {
    const ah = this.opts.heartbeat.activeHours;
    if (!withinActiveHours(now, ah.start, ah.end)) return false;
    const acquired = this.controlPlane.begin('heartbeat', now, this.opts.heartbeat.leaseMinutes * 60_000);
    if (!acquired.acquired || !acquired.run) return false;
    const runId = acquired.run.runId;
    try {
      const assessment = await this.opts.assess();
      const body = this.render(assessment).slice(0, this.opts.heartbeat.ackMaxChars);
      const actionable = assessment.status === 'actionable' && assessment.confidence >= this.opts.heartbeat.minConfidence;
      const novel = actionable && this.controlPlane.notificationAllowed('heartbeat', assessment, this.opts.heartbeat.cooldownMinutes * 60_000, now);
      const shouldPush = this.opts.heartbeat.mode === 'live' && novel;
      let pushed = false;
      if (shouldPush) {
        const delivered = await this.opts.onAck?.(body);
        pushed = delivered !== false && this.opts.onAck !== undefined;
        if (pushed) this.controlPlane.recordNotification('heartbeat', assessment, now);
      }
      const outcome = assessment.status === 'degraded' ? 'degraded' : this.opts.heartbeat.mode === 'shadow' ? 'shadow' : actionable ? 'success' : 'skipped';
      this.controlPlane.finish('heartbeat', runId, outcome, { output: assessment, metadata: { actionable, novel, pushed } });
      this.opts.logger.info({ msg: 'heartbeat assessed', runId, outcome, assessment, pushed });
      return true;
    } catch (error) {
      this.controlPlane.finish('heartbeat', runId, 'failed', { reason: error instanceof Error ? error.message : String(error) });
      this.opts.logger.warn({ msg: 'heartbeat failed', runId, error });
      return false;
    } finally {
      if (this.task) this.controlPlane.setNextScheduledAt('heartbeat', this.task.getNextRun());
    }
  }

  stop(): void { this.task?.stop(); this.task = null; }

  private render(value: HeartbeatAssessment): string {
    const evidence = value.evidence.length ? `\nEvidence: ${value.evidence.join('; ')}` : '';
    const action = value.suggestedAction ? `\nSuggested: ${value.suggestedAction}` : '';
    return `🫀 ${value.summary}${evidence}${action}`;
  }
}

export function armHeartbeat(opts: HeartbeatSchedulerOptions): HeartbeatScheduler | null {
  if (!opts.heartbeat.enabled) {
    opts.logger.info({ msg: 'heartbeat disabled by config' });
    return null;
  }
  const scheduler = new HeartbeatScheduler(opts);
  scheduler.start();
  return scheduler;
}
