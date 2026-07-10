/**
 * Heartbeat scheduler. Sends a periodic check-in to the agent (within
 * active hours) so it can run pending self-care: memory curate, error
 * triage, context staleness flag.
 */

import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import type { Conversation } from '../agent/conversation.js';
import type { Heartbeat } from '../config/schema.js';
import type { Logger } from 'pino';

export const HEARTBEAT_PROMPT =
  'HEARTBEAT: brief self-check. Anything stale, anything overdue, anything blocking? Reply in 3 lines max.';

export function withinActiveHours(now: Date, start: string, end: string): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(start);
  const b = toMin(end);
  return cur >= a && cur <= b;
}

export function intervalToCron(every: string): string {
  const m = /^(\d+)\s*([smhd])$/.exec(every.trim().toLowerCase());
  if (!m) return '0 */2 * * *';
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 's':
      return `*/${Math.max(1, Math.min(59, n))} * * * * *`;
    case 'm':
      return `*/${Math.max(1, Math.min(59, n))} * * * *`;
    case 'h':
      return `0 */${Math.max(1, Math.min(23, n))} * * *`;
    case 'd':
      return `0 0 */${Math.max(1, n)} * *`;
    default:
      return '0 */2 * * *';
  }
}

export interface HeartbeatSchedulerOptions {
  conversation: Conversation;
  heartbeat: Heartbeat;
  logger: Logger;
  onAck?: (text: string) => void;
}

export class HeartbeatScheduler {
  private task: ScheduledTask | null = null;

  constructor(private opts: HeartbeatSchedulerOptions) {}

  /** True while a cron task is scheduled (start() ran and stop() hasn't). */
  get running(): boolean {
    return this.task !== null;
  }

  start(): void {
    if (!this.opts.heartbeat.enabled) {
      this.opts.logger.info({ msg: 'heartbeat disabled by config' });
      return;
    }
    const expr = intervalToCron(this.opts.heartbeat.every);
    this.task = cronSchedule(expr, () => {
      void this.beat();
    });
    this.opts.logger.info({ msg: 'heartbeat scheduled', expr, every: this.opts.heartbeat.every });
  }

  /**
   * Run one heartbeat now. Skips (returns false) outside active hours or on
   * turn failure; returns true when a self-check turn actually ran. The cron
   * task calls this on every tick; tests and on-demand callers can too.
   */
  async beat(now: Date = new Date()): Promise<boolean> {
    const ah = this.opts.heartbeat.activeHours;
    if (!withinActiveHours(now, ah.start, ah.end)) return false;
    try {
      const turn = await this.opts.conversation.send(HEARTBEAT_PROMPT);
      const trimmed = turn.content.slice(0, this.opts.heartbeat.ackMaxChars);
      this.opts.logger.info({ msg: 'heartbeat ack', body: trimmed });
      this.opts.onAck?.(trimmed);
      return true;
    } catch (err) {
      this.opts.logger.warn({ msg: 'heartbeat failed', err });
      return false;
    }
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }
}

/**
 * Boot-time wiring seam, mirroring how the gateway arms the proactive
 * sentinel and AutomationManager: construct only when enabled, start
 * immediately, hand the instance back so shutdown paths can stop() it.
 * Returns null when heartbeat is disabled by config.
 */
export function armHeartbeat(opts: HeartbeatSchedulerOptions): HeartbeatScheduler | null {
  if (!opts.heartbeat.enabled) {
    opts.logger.info({ msg: 'heartbeat disabled by config' });
    return null;
  }
  const scheduler = new HeartbeatScheduler(opts);
  scheduler.start();
  return scheduler;
}
