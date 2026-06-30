/**
 * Telegram channel via grammy with bootstrap chat-ID gating.
 *
 * Trust model:
 * - If env.TELEGRAM_DEFAULT_CHAT_ID is set, only that chat can talk to the agent.
 * - If unset, the FIRST inbound message locks its chat_id as trusted (and the
 *   adapter writes the lock back to .env on disk).
 * - Untrusted chat_ids get a polite refusal and never reach the conversation
 *   loop. Their messages are not encoded into CORTEX.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Bot } from 'grammy';
import type { ChannelAdapter, ChannelStartOptions } from './types.js';
import type { Logger } from 'pino';
import { sanitizeOutbound } from '../safety/error-firewall.js';

export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private trustedChatId: string | null;

  constructor(
    private opts: {
      token: string;
      defaultChatId?: string;
      envPath?: string; // ~/.meridian/<agent>/.env, used to persist the bootstrap lock
      /** Display name the agent introduces itself with on first message.
       *  Defaults to "this agent" when not provided. */
      agentName?: string;
      logger: Logger;
    },
  ) {
    this.trustedChatId = opts.defaultChatId?.trim() || null;
  }

  async start(_c: unknown, opts: ChannelStartOptions): Promise<void> {
    this.bot = new Bot(this.opts.token);

    const greeting = this.opts.agentName ?? 'this agent';
    this.bot.command('start', (ctx) => {
      ctx.reply(
        this.trustedChatId === null
          ? `${greeting} here. You are the first to message on Meridian. Locking your chat as trusted.`
          : `${greeting} here.`,
      );
    });

    this.bot.on('message:text', async (ctx) => {
      const fromChatId = String(ctx.chat.id);

      // Bootstrap: first sender becomes trusted.
      if (this.trustedChatId === null) {
        this.trustedChatId = fromChatId;
        this.persistTrustedChatId(fromChatId);
        this.opts.logger.info({ msg: 'telegram trusted chat locked', chatId: fromChatId });
      }

      // Reject anyone who isn't the trusted chat.
      if (fromChatId !== this.trustedChatId) {
        await ctx.reply(
          'I do not recognize this chat. This agent only responds to its trusted operator.',
        );
        this.opts.logger.warn({
          msg: 'telegram rejected untrusted chat',
          fromChatId,
          username: ctx.from?.username,
        });
        return;
      }

      // Typing indicator: Telegram's "typing" lasts ~5s, refresh it every 4s
      // until the turn completes. Gives the operator visual feedback that the
      // agent is actively thinking (CORTEX recall + LLM stream + encode can
      // take 30-90s).
      await ctx.replyWithChatAction('typing').catch(() => {});
      let stillThinking = true;
      const typingHeartbeat = setInterval(() => {
        if (stillThinking) ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const reply = await opts.onInbound({
          channel: 'telegram',
          from: fromChatId,
          text: ctx.message.text,
          meta: { username: ctx.from?.username, trusted: true },
        });
        stillThinking = false;
        clearInterval(typingHeartbeat);
        // Last-mile RULE ZERO net (defense-in-depth; turn.ts already sanitizes,
        // but a non-turn onInbound or future caller is covered here too).
        for (const chunk of splitForTelegram(sanitizeOutbound(reply))) {
          await ctx.reply(chunk);
        }
      } catch (err) {
        stillThinking = false;
        clearInterval(typingHeartbeat);
        this.opts.logger.error({ msg: 'telegram inbound error', err });
        await ctx.reply('Something went wrong on my end. I have logged it.');
      }
    });

    this.bot.catch((err) => this.opts.logger.error({ msg: 'telegram error', err }));
    this.bot.start({ drop_pending_updates: true }).catch((err) => {
      this.opts.logger.error({ msg: 'telegram bot start failed', err });
    });
    this.opts.logger.info({
      msg: 'telegram channel started',
      trustedChatId: this.trustedChatId ?? '(awaiting first sender to lock)',
    });
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
    this.bot = null;
  }

  async send(msg: { to: string; text: string }): Promise<void> {
    if (!this.bot) throw new Error('telegram bot not started');
    // Proactive/outbound (sentinel briefs etc.) bypass turn.ts — sanitize here.
    for (const chunk of splitForTelegram(sanitizeOutbound(msg.text))) {
      await this.bot.api.sendMessage(msg.to, chunk);
    }
  }

  private persistTrustedChatId(chatId: string): void {
    const envPath = this.opts.envPath;
    if (!envPath || !existsSync(envPath)) return;
    try {
      const raw = readFileSync(envPath, 'utf8');
      const updated = raw.includes('TELEGRAM_DEFAULT_CHAT_ID=')
        ? raw.replace(/TELEGRAM_DEFAULT_CHAT_ID=.*/g, `TELEGRAM_DEFAULT_CHAT_ID=${chatId}`)
        : `${raw.trimEnd()}\nTELEGRAM_DEFAULT_CHAT_ID=${chatId}\n`;
      writeFileSync(envPath, updated);
      this.opts.logger.info({ msg: 'persisted trusted chat id to env', envPath });
    } catch (err) {
      this.opts.logger.warn({ msg: 'failed to persist trusted chat id', err });
    }
  }
}

/**
 * Telegram caps a single message at 4096 chars; we leave headroom and split on
 * paragraph → sentence → hard boundary in that order. Avoids mid-word breaks
 * and the silent "message is too long" 400 from grammy.
 */
const TELEGRAM_MAX = 3900;

export function splitForTelegram(text: string, max: number = TELEGRAM_MAX): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return ['(empty reply)'];
  if (trimmed.length <= max) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
