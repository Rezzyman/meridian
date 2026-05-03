/**
 * Structured logger. JSON in production, pretty in dev.
 * Per-agent log file when home is provided.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import type { MeridianHome } from '../config/home.js';

export type { Logger };

export function createLogger(opts: { home?: MeridianHome; level?: string } = {}): Logger {
  const level = opts.level ?? process.env.MERIDIAN_LOG_LEVEL ?? 'info';
  const isTty = process.stdout.isTTY;

  if (opts.home) {
    if (!existsSync(opts.home.logs)) mkdirSync(opts.home.logs, { recursive: true });
    const logPath = join(opts.home.logs, 'meridian.log');
    const dest = pino.destination({ dest: logPath, append: true, sync: false });
    return pino({ level, base: { agent: opts.home.agentSlug } }, dest);
  }

  if (isTty) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }

  return pino({ level });
}
