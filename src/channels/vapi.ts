/**
 * VAPI voice channel adapter — Meridian's headline feature.
 *
 * The flow:
 *  1. VAPI POSTs webhook events to /vapi/webhook on the gateway.
 *  2. The gateway extracts caller phone, transcript, and event type.
 *  3. We emit an InboundMessage with channel='voice' and from=<phone>.
 *  4. The agent's CORTEX recall fires using the phone number as a strong
 *     contextual hint, surfacing prior calls from the same caller.
 *  5. The reply text is returned; VAPI synthesizes it via TTS on the call.
 *
 * What makes this different from raw VAPI:
 *  - CORTEX-encoded transcript per turn with channel:voice valence axis.
 *  - The next call from the same phone number triggers cross-call recall:
 *    "Hi John, glad you called back. Earlier you were asking about..."
 */

import type { ChannelAdapter, InboundMessage } from './types.js';
import type { Logger } from 'pino';
import type { MemoryProvider } from '../memory/provider.js';
import type { VoiceSessionGuard } from '../voice/session-guard.js';

export interface VapiToolCall {
  id?: string;
  type?: string;
  function?: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

export interface VapiWebhookEvent {
  type:
    | 'function-call'
    | 'tool-calls'
    | 'transcript'
    | 'end-of-call-report'
    | 'speech-update'
    | 'status-update';
  call?: {
    id: string;
    customer?: { number?: string };
    startedAt?: string;
    endedAt?: string;
  };
  transcript?: string;
  artifact?: { transcript?: string; messages?: Array<{ role: string; message?: string; content?: string }> };
  message?: { role: string; content: string };
  endedReason?: string;
  summary?: string;
  recordingUrl?: string;
  durationSeconds?: number;
  // Legacy single function-call format
  functionCall?: { name: string; parameters?: Record<string, unknown> };
  // Modern tool-calls format
  toolCallList?: VapiToolCall[];
  toolCalls?: VapiToolCall[];
}

/**
 * Server-side handler for a VAPI tool invocation. Receives the tool name
 * and parsed args; returns a string (or JSON-serializable object) that
 * VAPI will hand back to its model. Throw to surface an error to the model.
 */
export type VapiToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  ctx: { callId?: string; phone: string },
) => Promise<unknown>;

export class VapiChannel implements ChannelAdapter {
  readonly name = 'vapi';
  private handler: ((m: InboundMessage) => Promise<string>) | null = null;
  private cortex?: MemoryProvider;
  private telegramDM?: (text: string) => Promise<void>;
  private executeTool?: VapiToolExecutor;
  private voiceGuard?: VoiceSessionGuard;

  constructor(private opts: {
    logger: Logger;
    webhookSecret?: string;
    cortex?: MemoryProvider;
    telegramDM?: (text: string) => Promise<void>;
    executeTool?: VapiToolExecutor;
    voiceGuard?: VoiceSessionGuard;
    /** VAPI API key for outbound calls. Required when placeOutboundCall() is used. */
    vapiApiKey?: string;
    /** Default phoneNumberId for outbound calls. Optional override per call. */
    phoneNumberId?: string;
    /** Default assistantId for outbound calls. Optional override per call. */
    assistantId?: string;
  }) {
    this.cortex = opts.cortex;
    this.telegramDM = opts.telegramDM;
    this.executeTool = opts.executeTool;
    this.voiceGuard = opts.voiceGuard;
  }

  /**
   * Place an outbound voice call via VAPI. Required for the onboarding
   * "agent calls you to introduce itself" moment, after-hours proactive
   * follow-ups, and any flow where Meridian initiates the conversation.
   *
   * Caller supplies the target E.164 number and optional per-call overrides
   * (assistant override for a call-specific persona, custom firstMessage so
   * the agent opens with context the caller hasn't given yet).
   */
  async placeOutboundCall(opts: {
    /** E.164 number, e.g. "+13035551234". */
    to: string;
    /** Override the configured phoneNumberId for this call. */
    phoneNumberId?: string;
    /** Override the configured assistantId for this call. */
    assistantId?: string;
    /** First spoken message; if omitted, the assistant uses its configured opener. */
    firstMessage?: string;
    /** Customer name passed to the assistant for personalized greetings. */
    customerName?: string;
    /** Free-form metadata stamped on the call record (operator id, signup flow id, etc). */
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; status: string }> {
    const apiKey = this.opts.vapiApiKey;
    if (!apiKey) {
      throw new Error(
        'VAPI_API_KEY not configured on the channel. Set it in the agent .env and rebuild the gateway with the key passed into VapiChannel options.',
      );
    }
    const phoneNumberId = opts.phoneNumberId ?? this.opts.phoneNumberId;
    const assistantId = opts.assistantId ?? this.opts.assistantId;
    if (!phoneNumberId) throw new Error('phoneNumberId required for outbound call (set VAPI_PHONE_NUMBER_ID in env or pass per-call).');
    if (!assistantId) throw new Error('assistantId required for outbound call (set VAPI_ASSISTANT_ID in env or pass per-call).');

    const body: Record<string, unknown> = {
      phoneNumberId,
      assistantId,
      customer: {
        number: opts.to,
        ...(opts.customerName ? { name: opts.customerName } : {}),
      },
    };

    // Per-call overrides — used when the calling-context (signup wizard,
    // proactive follow-up) wants the agent to open with a specific line
    // tailored to the situation. Both are optional.
    if (opts.firstMessage || opts.customerName) {
      body.assistantOverrides = {
        ...(opts.firstMessage ? { firstMessage: opts.firstMessage } : {}),
        ...(opts.customerName
          ? { variableValues: { customerName: opts.customerName } }
          : {}),
      };
    }
    if (opts.metadata) body.metadata = opts.metadata;

    const res = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`VAPI outbound call failed (${res.status}): ${errText.slice(0, 300)}`);
    }
    const json = (await res.json()) as { id?: string; status?: string };
    if (!json.id) throw new Error(`VAPI returned no call id; payload: ${JSON.stringify(json).slice(0, 200)}`);
    this.opts.logger.info({
      msg: 'vapi outbound call placed',
      callId: json.id,
      to: opts.to,
      assistantId,
      hasOverride: !!body.assistantOverrides,
    });
    return { id: json.id, status: json.status ?? 'queued' };
  }

  /** Expose the guard to the gateway so executeTool can check unlock state. */
  isCallUnlocked(callId: string | undefined): boolean {
    return this.voiceGuard?.isUnlocked(callId) ?? false;
  }

  async start(
    _c: unknown,
    opts: { onInbound: (msg: InboundMessage) => Promise<string> },
  ): Promise<void> {
    this.handler = opts.onInbound;
    this.opts.logger.info({ msg: 'vapi channel armed; awaiting webhook events from gateway' });
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  /** Called by the gateway HTTP layer when VAPI hits /vapi/webhook. */
  async dispatch(event: VapiWebhookEvent): Promise<unknown> {
    // VAPI sometimes wraps payloads in `{ message: {...} }`. Normalize.
    const raw = event as unknown as { message?: VapiWebhookEvent };
    if (raw.message && typeof raw.message === 'object' && (raw.message as VapiWebhookEvent).type) {
      event = { ...raw.message, call: raw.message.call ?? event.call } as VapiWebhookEvent;
    }

    if (!this.handler) return {};
    const phone = event.call?.customer?.number ?? 'unknown';
    const callId = event.call?.id;

    // ── Function / tool calls — VAPI's model is asking the server to run a tool.
    if (event.type === 'function-call' || event.type === 'tool-calls') {
      return this.handleToolInvocation(event, phone, callId);
    }

    // ── End-of-call rollup → CORTEX (no reply expected; VAPI is closing the leg).
    if (event.type === 'end-of-call-report') {
      await this.encodeCallSummary(event, phone, callId);
      // Tear down any unlock state for this call so the next call from the
      // same caller starts in PUBLIC mode again.
      this.voiceGuard?.lock(callId);
      return {};
    }

    let text = '';
    if (event.type === 'transcript' && event.transcript) text = event.transcript;
    else if (event.message?.content) text = event.message.content;
    else if (event.artifact?.transcript) text = event.artifact.transcript;
    if (!text) return {};

    // ── Voice passphrase scan ──
    // Strip the passphrase BEFORE the model sees it. If the only thing the
    // caller said was the phrase, return silently — nothing to respond to,
    // no transcript to encode. The unlock survives for 30 min on this callId.
    if (this.voiceGuard) {
      const scan = this.voiceGuard.scanAndUnlock(callId, text);
      if (scan.unlocked) {
        this.opts.logger.info({ msg: 'voice unlock matched on transcript', callId, phone });
      }
      if (scan.empty) {
        return {}; // caller said only the passphrase; do not invoke the model
      }
      text = scan.stripped;
    }

    const reply = await this.handler({
      channel: 'voice',
      from: phone,
      text,
      meta: { callId, eventType: event.type, unlocked: this.isCallUnlocked(callId) },
    });
    return { reply };
  }

  /**
   * Run a tool VAPI's model invoked. Supports both legacy `function-call`
   * (single tool, response shape `{ result }`) and modern `tool-calls`
   * (batch, response shape `{ results: [{ toolCallId, result }] }`).
   *
   * Tool execution is delegated to `executeTool` injected at construction.
   * No tool runs unless the gateway whitelisted it.
   */
  private async handleToolInvocation(
    event: VapiWebhookEvent,
    phone: string,
    callId?: string,
  ): Promise<unknown> {
    if (!this.executeTool) {
      this.opts.logger.warn({ msg: 'vapi tool call but no executor wired', callId });
      return { error: 'tool execution not configured' };
    }

    // Legacy single function-call.
    if (event.type === 'function-call' && event.functionCall) {
      const name = event.functionCall.name;
      const args = event.functionCall.parameters ?? {};
      try {
        const result = await this.executeTool(name, args, { callId, phone });
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        this.opts.logger.info({ msg: 'vapi tool ok (legacy)', name, callId, chars: resultStr.length });
        return { result: resultStr };
      } catch (err) {
        const msg = (err as Error).message;
        this.opts.logger.error({ msg: 'vapi tool failed (legacy)', name, callId, err });
        return { error: msg };
      }
    }

    // Modern tool-calls (batch). VAPI may send either `toolCallList` or `toolCalls`.
    const calls = event.toolCallList ?? event.toolCalls ?? [];
    const results: Array<{ toolCallId: string; result?: string; error?: string }> = [];
    for (const tc of calls) {
      const id = tc.id ?? '';
      const name = tc.function?.name ?? '';
      let args: Record<string, unknown> = {};
      const rawArgs = tc.function?.arguments;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch { args = {}; }
      } else if (rawArgs && typeof rawArgs === 'object') {
        args = rawArgs as Record<string, unknown>;
      }
      if (!name) {
        results.push({ toolCallId: id, error: 'missing function name' });
        continue;
      }
      try {
        const result = await this.executeTool(name, args, { callId, phone });
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        results.push({ toolCallId: id, result: resultStr });
        this.opts.logger.info({ msg: 'vapi tool ok', name, callId, toolCallId: id });
      } catch (err) {
        const msg = (err as Error).message;
        results.push({ toolCallId: id, error: msg });
        this.opts.logger.error({ msg: 'vapi tool failed', name, callId, toolCallId: id, err });
      }
    }
    return { results };
  }

  /**
   * Encode a single durable memory representing the entire call. Per-utterance
   * encodes already happened during the call via Conversation.send; this is
   * the rollup so the next call from the same caller can recall "what we
   * talked about last time" in one synapse traversal instead of N.
   */
  private async encodeCallSummary(
    event: VapiWebhookEvent,
    phone: string,
    callId?: string,
  ): Promise<void> {
    if (!this.cortex) {
      this.opts.logger.warn({ msg: 'vapi end-of-call: no cortex bound, skipping rollup encode' });
      return;
    }
    // Prefer VAPI's own summary if present; otherwise stitch the transcript.
    const fullTranscript =
      event.summary?.trim() ||
      event.artifact?.transcript?.trim() ||
      this.stitchMessages(event.artifact?.messages) ||
      '';
    if (!fullTranscript) {
      this.opts.logger.warn({ msg: 'vapi end-of-call: empty transcript, skipping', callId });
      return;
    }
    const header = [
      `# Voice call rollup`,
      `caller: ${phone}`,
      callId ? `call_id: ${callId}` : '',
      event.call?.startedAt ? `started: ${event.call.startedAt}` : '',
      event.call?.endedAt ? `ended: ${event.call.endedAt}` : '',
      typeof event.durationSeconds === 'number' ? `duration_s: ${event.durationSeconds}` : '',
      event.endedReason ? `ended_reason: ${event.endedReason}` : '',
      event.recordingUrl ? `recording: ${event.recordingUrl}` : '',
    ].filter(Boolean).join('\n');
    const content = `${header}\n\n${fullTranscript}`;
    try {
      const result = await this.cortex.encode(content, {
        source: `vapi:call:${callId ?? 'unknown'}`,
        priority: 3,
        channel: 'voice',
        sensitivity: 'internal',
      });
      this.opts.logger.info({
        msg: 'vapi end-of-call rollup encoded',
        callId,
        phone,
        memoryId: result.memoryId,
        chars: content.length,
      });

      // Optional: nudge the operator on Telegram with a one-line summary.
      if (this.telegramDM && event.summary?.trim()) {
        const oneLiner = event.summary.split('\n')[0].slice(0, 280);
        await this.telegramDM(`Call from ${phone} ended (${event.endedReason ?? 'normal'}):\n${oneLiner}`)
          .catch((err) => this.opts.logger.warn({ msg: 'telegram dm failed', err }));
      }
    } catch (err) {
      this.opts.logger.error({ msg: 'vapi end-of-call rollup encode failed', err, callId });
    }
  }

  private stitchMessages(messages?: Array<{ role: string; message?: string; content?: string }>): string {
    if (!messages?.length) return '';
    return messages
      .map((m) => {
        const t = (m.message ?? m.content ?? '').trim();
        if (!t) return '';
        return `${m.role}: ${t}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  verifyWebhook(headerSecret?: string): boolean {
    if (!this.opts.webhookSecret) return true;
    return headerSecret === this.opts.webhookSecret;
  }
}
