import type { Logger } from 'pino';

/**
 * Operations alert sink (WS5). Infra and health notices must never ride the
 * agent's own operator chat: "a message from Arlo about work Arlo did not do"
 * was a real confusion incident. Alerts go to a dedicated chat id when one
 * is configured (MERIDIAN_OPS_CHAT_ID, sent with the same bot), otherwise
 * they are log-only. Rate limited per key so a stuck condition does not spam.
 */
export interface OpsAlerter {
  alert(key: string, text: string): Promise<boolean>;
  readonly destination: 'telegram' | 'log';
}

export function createOpsAlerter(opts: {
  logger: Logger;
  chatId?: string;
  send?: (chatId: string, text: string) => Promise<void>;
  cooldownMs?: number;
  now?: () => number;
}): OpsAlerter {
  const last = new Map<string, number>();
  const cooldown = opts.cooldownMs ?? 6 * 3600_000;
  const now = opts.now ?? Date.now;
  const destination: 'telegram' | 'log' = opts.chatId && opts.send ? 'telegram' : 'log';
  return {
    destination,
    async alert(key, text) {
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < cooldown) return false;
      last.set(key, t);
      opts.logger.warn({ msg: 'ops alert', key, text, destination });
      if (destination === 'telegram') {
        try {
          await opts.send!(opts.chatId!, `[meridian ops] ${text}`);
        } catch (err) {
          opts.logger.error({ msg: 'ops alert delivery failed', key, err });
          return false;
        }
      }
      return true;
    },
  };
}
