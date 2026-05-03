/**
 * Telegram tools — let the agent DM the operator from any channel.
 *
 * The headline use case: a voice call escalates and the agent needs to
 * reach the operator off-channel. The agent calls `telegram_dm` with a
 * one-line summary; the operator gets the message in their phone immediately
 * even if the call is still live.
 *
 * Sends directly via the Telegram Bot HTTP API. No coupling to the
 * TelegramChannel adapter — works whether or not the gateway is running
 * a Telegram listener.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { AgentEnv } from '../../config/schema.js';

const TELEGRAM_BASE = 'https://api.telegram.org';

export function telegramTools(env: AgentEnv) {
  return {
    telegram_dm: tool({
      description:
        "Send a Telegram direct message to the operator. Use this to reach the operator " +
        "from any channel (e.g. mid-voice-call when the call needs human handoff, or to " +
        "push a one-line summary after an automation). The message goes to the trusted " +
        "chat id configured at gateway boot.",
      parameters: z.object({
        text: z.string().describe('The message body. Plain text. Keep under 4000 chars.'),
        chatId: z.string().optional().describe('Override the default chat id. Rarely needed.'),
      }),
      execute: async ({ text, chatId }) => {
        if (!env.TELEGRAM_BOT_TOKEN) {
          return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
        }
        const target = chatId ?? env.TELEGRAM_DEFAULT_CHAT_ID;
        if (!target) {
          return { ok: false, error: 'no chat id (set TELEGRAM_DEFAULT_CHAT_ID or pass chatId)' };
        }
        const body = text.length > 4000 ? text.slice(0, 3990) + '\n…' : text;
        const res = await fetch(`${TELEGRAM_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: target, text: body }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          return { ok: false, status: res.status, error: errText.slice(0, 200) };
        }
        const j = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
        return { ok: true, chatId: target, messageId: j.result?.message_id, chars: body.length };
      },
    }),
  };
}
