/**
 * Telegram channel via grammy with bootstrap chat-ID gating.
 *
 * Trust model:
 * - If env.TELEGRAM_DEFAULT_CHAT_ID is set, only that chat can talk to the agent.
 * - If unset, the FIRST inbound message locks its chat_id as trusted (and the
 *   adapter writes the lock back to .env on disk).
 * - Untrusted chat_ids get a polite refusal and never reach the conversation
 *   loop. Their messages are not encoded into CORTEX.
 *
 * Inbound images (photos + image documents) are downloaded to the agent's
 * media dir, run through the vision runtime (operator's custom prompt), and
 * fed to the turn as the caption plus a CLEARLY MARKED analysis block. Trust
 * gating is identical to text — media from an untrusted chat never touches
 * disk or the model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Bot } from 'grammy';
import type { ChannelAdapter, ChannelStartOptions } from './types.js';
import type { Logger } from 'pino';

/** Vision hook wired by the gateway; absent = vision disabled. */
export interface TelegramVisionDeps {
  /** Analyze a downloaded image file (the gateway closes this over the
   *  agent's router + vision config, including the operator prompt). */
  analyze: (path: string, caption?: string) => Promise<{ description: string; model: string }>;
}

/** Structural slice of the grammy context the media handler needs — kept
 *  minimal so tests can drive it without a live Bot. */
export interface TelegramMediaContext {
  chat: { id: number | string };
  from?: { username?: string };
  message: {
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  getFile(): Promise<{ file_unique_id: string; file_size?: number; file_path?: string }>;
  reply(text: string): Promise<unknown>;
  replyWithChatAction(action: 'typing'): Promise<unknown>;
}

export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private trustedChatId: string | null;
  private fetchFile: (url: string) => Promise<Buffer>;

  constructor(
    private opts: {
      token: string;
      defaultChatId?: string;
      envPath?: string; // ~/.meridian/<agent>/.env, used to persist the bootstrap lock
      /** Display name the agent introduces itself with on first message.
       *  Defaults to "this agent" when not provided. */
      agentName?: string;
      logger: Logger;
      /** Where inbound media lands (MEMORY/media). No dir = media disabled. */
      mediaDir?: string;
      /** Inbound media size cap in bytes (default 25 MB). */
      maxMediaBytes?: number;
      /** Vision runtime hook; absent = images are saved + noted, not analyzed. */
      vision?: TelegramVisionDeps;
      /** Injectable downloader (tests). Defaults to fetch(). */
      fetchFile?: (url: string) => Promise<Buffer>;
    },
  ) {
    this.trustedChatId = opts.defaultChatId?.trim() || null;
    this.fetchFile =
      opts.fetchFile ??
      (async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      });
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
      if (!this.gateTrusted(String(ctx.chat.id), ctx.from?.username, (t) => ctx.reply(t))) return;
      const fromChatId = String(ctx.chat.id);

      // Typing indicator: Telegram's "typing" lasts ~5s, refresh it every 4s
      // until the turn completes. Gives the operator visual feedback that the
      // agent is actively thinking (CORTEX recall + LLM stream + encode can
      // take 30-90s).
      const stopTyping = this.startTyping(ctx);

      try {
        const reply = await opts.onInbound({
          channel: 'telegram',
          from: fromChatId,
          text: ctx.message.text,
          meta: { username: ctx.from?.username, trusted: true },
        });
        stopTyping();
        for (const chunk of splitForTelegram(reply)) {
          await ctx.reply(chunk);
        }
      } catch (err) {
        stopTyping();
        this.opts.logger.error({ msg: 'telegram inbound error', err });
        await ctx.reply('Something went wrong on my end. I have logged it.');
      }
    });

    // Inbound media: photos, and documents that are images. Same trust lock
    // as text; the handler downloads, analyzes, and feeds the turn.
    this.bot.on('message:photo', async (ctx) => {
      await this.handleMediaMessage(ctx as unknown as TelegramMediaContext, opts.onInbound);
    });
    this.bot.on('message:document', async (ctx) => {
      await this.handleMediaMessage(ctx as unknown as TelegramMediaContext, opts.onInbound);
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

  /**
   * Inbound photo / image-document handler. Public so tests can drive it with
   * a structural mock context — no live Bot required.
   */
  async handleMediaMessage(
    ctx: TelegramMediaContext,
    onInbound: ChannelStartOptions['onInbound'],
  ): Promise<void> {
    const fromChatId = String(ctx.chat.id);
    if (!this.gateTrusted(fromChatId, ctx.from?.username, (t) => ctx.reply(t))) return;

    const doc = ctx.message.document;
    const isPhoto = (ctx.message.photo?.length ?? 0) > 0;
    const isImageDoc = !!doc?.mime_type?.startsWith('image/');
    if (!isPhoto && !isImageDoc) {
      if (doc) {
        await ctx.reply(
          'I can only view images over chat right now. For documents, drop the file in my ingest inbox or run `meridian ingest <path>`.',
        );
      }
      return;
    }
    if (!this.opts.mediaDir) {
      await ctx.reply('I received the image, but media handling is not configured on this agent.');
      return;
    }

    const maxBytes = this.opts.maxMediaBytes ?? 25 * 1024 * 1024;
    const declaredSize = doc?.file_size ?? ctx.message.photo?.at(-1)?.file_size;
    if (declaredSize && declaredSize > maxBytes) {
      await ctx.reply(
        `That image is too large for me to process (limit ${Math.floor(maxBytes / (1024 * 1024))} MB).`,
      );
      return;
    }

    const stopTyping = this.startTyping(ctx);
    try {
      // grammy's ctx.getFile() resolves the message's media (largest photo size).
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('telegram returned no file_path');
      if (file.file_size && file.file_size > maxBytes) {
        stopTyping();
        await ctx.reply(
          `That image is too large for me to process (limit ${Math.floor(maxBytes / (1024 * 1024))} MB).`,
        );
        return;
      }
      const data = await this.fetchFile(
        `https://api.telegram.org/file/bot${this.opts.token}/${file.file_path}`,
      );
      if (data.byteLength > maxBytes) {
        stopTyping();
        await ctx.reply(
          `That image is too large for me to process (limit ${Math.floor(maxBytes / (1024 * 1024))} MB).`,
        );
        return;
      }
      mkdirSync(this.opts.mediaDir, { recursive: true });
      const ext = extname(doc?.file_name ?? basename(file.file_path)) || '.jpg';
      const filename = `tg-${Date.now().toString(36)}-${file.file_unique_id}${ext}`;
      const savedPath = join(this.opts.mediaDir, filename);
      writeFileSync(savedPath, data);

      const caption = ctx.message.caption?.trim() || '';

      // Vision pass — the operator's custom prompt lives inside `analyze`
      // (wired by the gateway from config.vision). Failure falls back to a
      // path note; the sanitized error message is safe to show.
      let analysisBlock: string;
      if (this.opts.vision) {
        try {
          const a = await this.opts.vision.analyze(savedPath, caption || undefined);
          analysisBlock =
            `[Attached image "${filename}" — automated vision analysis via ${a.model}; ` +
            `this description was generated by a model, not written by the sender]\n${a.description}`;
        } catch (err) {
          this.opts.logger.warn({ msg: 'telegram image analysis failed', err });
          analysisBlock = `[Attached image "${filename}" saved to ${savedPath} — vision analysis failed, so no description is available]`;
        }
      } else {
        analysisBlock = `[Attached image "${filename}" saved to ${savedPath} — vision analysis is disabled on this agent]`;
      }

      const turnText = [
        caption || '(The user sent an image with no caption.)',
        '',
        analysisBlock,
      ].join('\n');

      const reply = await onInbound({
        channel: 'telegram',
        from: fromChatId,
        text: turnText,
        meta: {
          username: ctx.from?.username,
          trusted: true,
          media: { path: savedPath, kind: isPhoto ? 'photo' : 'document-image' },
        },
      });
      stopTyping();
      for (const chunk of splitForTelegram(reply)) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      stopTyping();
      this.opts.logger.error({ msg: 'telegram media inbound error', err });
      await ctx.reply('I could not process that image. I have logged the issue.');
    }
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
    this.bot = null;
  }

  async send(msg: { to: string; text: string }): Promise<void> {
    if (!this.bot) throw new Error('telegram bot not started');
    for (const chunk of splitForTelegram(msg.text)) {
      await this.bot.api.sendMessage(msg.to, chunk);
    }
  }

  /**
   * Shared trust lock for text AND media. Bootstrap: the first sender becomes
   * trusted (persisted to .env); everyone else gets a refusal and never
   * reaches the conversation loop.
   */
  private gateTrusted(
    fromChatId: string,
    username: string | undefined,
    reply: (text: string) => Promise<unknown>,
  ): boolean {
    if (this.trustedChatId === null) {
      this.trustedChatId = fromChatId;
      this.persistTrustedChatId(fromChatId);
      this.opts.logger.info({ msg: 'telegram trusted chat locked', chatId: fromChatId });
    }
    if (fromChatId !== this.trustedChatId) {
      void reply(
        'I do not recognize this chat. This agent only responds to its trusted operator.',
      ).catch(() => {});
      this.opts.logger.warn({
        msg: 'telegram rejected untrusted chat',
        fromChatId,
        username,
      });
      return false;
    }
    return true;
  }

  /** Refreshing typing indicator; returns a stop function. */
  private startTyping(ctx: { replyWithChatAction(action: 'typing'): Promise<unknown> }): () => void {
    void ctx.replyWithChatAction('typing').catch(() => {});
    let alive = true;
    const heartbeat = setInterval(() => {
      if (alive) void ctx.replyWithChatAction('typing').catch(() => {});
    }, 4000);
    return () => {
      alive = false;
      clearInterval(heartbeat);
    };
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
