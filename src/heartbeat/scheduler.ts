/**
 * Heartbeat scheduler. Sends a periodic check-in to the agent (within
 * active hours) so it can run pending self-care: memory curate, error
 * triage, context staleness flag.
 */

import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import type { Conversation } from '../agent/conversation.js';
import type { Heartbeat } from '../config/schema.js';
import type { Logger } from 'pino';

function withinActiveHours(now: Date, start: string, end: string): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(start);
  const b = toMin(end);
  return cur >= a && cur <= b;
}

function intervalToCron(every: string): string {
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

export class HeartbeatScheduler {
  private task: ScheduledTask | null = null;

  constructor(
    private opts: {
      conversation: Conversation;
      heartbeat: Heartbeat;
      logger: Logger;
      onAck?: (text: string) => void;
    },
  ) {}

  start(): void {
    if (!this.opts.heartbeat.enabled) {
      this.opts.logger.info({ msg: 'heartbeat disabled by config' });
      return;
    }
    const expr = intervalToCron(this.opts.heartbeat.every);
    this.task = cronSchedule(expr, async () => {
      const now = new Date();
      const ah = this.opts.heartbeat.activeHours;
      if (!withinActiveHours(now, ah.start, ah.end)) return;
      try {
        const turn = await this.opts.conversation.send(
          'HEARTBEAT: brief self-check. Anything stale, anything overdue, anything blocking? Reply in 3 lines max.',
        );
        const trimmed = turn.content.slice(0, this.opts.heartbeat.ackMaxChars);
        this.opts.logger.info({ msg: 'heartbeat ack', body: trimmed });
        this.opts.onAck?.(trimmed);
      } catch (err) {
        this.opts.logger.warn({ msg: 'heartbeat failed', err });
      }
    });
    this.opts.logger.info({ msg: 'heartbeat scheduled', expr, every: this.opts.heartbeat.every });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }
}
