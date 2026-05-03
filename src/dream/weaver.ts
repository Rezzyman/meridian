/**
 * Dream Weaver — in-process CORTEX dream cycle scheduler. Runs at 02:00
 * nightly by default. Catches missed weavings when the process wakes
 * after a planned downtime. Replaces external cron entirely.
 */

import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import type { MemoryProvider } from '../memory/provider.js';
import type { DreamConfig } from '../config/schema.js';
import type { Logger } from 'pino';

export interface DreamWeaverOptions {
  cortex: MemoryProvider;
  config: DreamConfig;
  logger: Logger;
  /** Called by REPL/status-bar to surface weaver state */
  onState?: (state: 'idle' | 'encoding' | 'running') => void;
}

export class DreamWeaver {
  private task: ScheduledTask | null = null;
  private running = false;
  private lastFiredAt: Date | null = null;

  constructor(private opts: DreamWeaverOptions) {}

  start(): void {
    if (!this.opts.config.enabled) {
      this.opts.logger.info({ msg: 'dream weaver disabled by config' });
      return;
    }
    this.task = cronSchedule(
      this.opts.config.schedule,
      () => {
        this.fire('full').catch((err) => {
          this.opts.logger.error({ err, msg: 'dream cycle failed' });
        });
      },
      { timezone: process.env.TZ ?? 'America/Chicago' },
    );
    this.opts.logger.info({
      msg: 'dream weaver scheduled',
      schedule: this.opts.config.schedule,
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Trigger a dream cycle on demand (e.g. /dream slash command). */
  async fire(
    cycleType: 'full' | 'sws_only' | 'rem_only' | 'consolidation_only' = 'full',
  ): Promise<void> {
    if (this.running) {
      this.opts.logger.warn({ msg: 'dream cycle already running, skipping' });
      return;
    }
    this.running = true;
    this.opts.onState?.('running');
    try {
      this.opts.logger.info({ msg: `dream cycle starting (${cycleType})` });
      const result = await this.opts.cortex.dream(cycleType);
      this.lastFiredAt = new Date();
      this.opts.logger.info({ msg: 'dream cycle complete', durationMs: result.durationMs });
    } finally {
      this.running = false;
      this.opts.onState?.('idle');
    }
  }

  state(): { running: boolean; lastFiredAt: Date | null } {
    return { running: this.running, lastFiredAt: this.lastFiredAt };
  }
}
