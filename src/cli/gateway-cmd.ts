/**
 * `meridian gateway` — start HTTP gateway plus all configured channels.
 *
 * Each channel runs its OWN Conversation instance with the right channel
 * label so the per-turn sensitivity gate fires correctly. Voice gets a
 * voice-channel conversation (public-only recall, sacred-block check).
 * Telegram gets a telegram-channel conversation (full trust + chat-ID gate).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeAgentSlug, ensureAgentHome, loadAgentConfig } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { createMemoryProvider } from '../memory/index.js';
import { ProviderRouter } from '../providers/router.js';
import { Conversation } from '../agent/conversation.js';
import { DreamWeaver } from '../dream/weaver.js';
import { buildToolSurface } from '../agent/tool-surface.js';
import { createLogger } from '../logger/pino.js';
import { TelegramChannel } from '../channels/telegram.js';
import { VapiChannel } from '../channels/vapi.js';
import { VoiceSessionGuard } from '../voice/session-guard.js';
import { startGateway } from '../gateway/server.js';
import { colors } from '../utils/truecolor.js';
import { resolveOperator, operatorSessionId } from '../agent/operator.js';
import { SessionStore } from '../session/store.js';
import { ProactiveSentinel } from '../proactive/sentinel.js';
import { AutomationManager } from '../automations/manager.js';
import { watchInbox } from '../ingest/file-ingest.js';
import { mkdirSync } from 'node:fs';
import type { ChannelKind } from '../agent/operator.js';
import type { MeridianTurn } from '../agent/types.js';
import type { ChannelAdapter } from '../channels/types.js';

function readSystemBase(home: ReturnType<typeof ensureAgentHome>, agentName: string): string {
  const id = join(home.layer('IDENTITY'), 'AGENT.md');
  const usr = join(home.layer('IDENTITY'), 'USER.md');
  const parts = [`You are ${agentName}, a Meridian agent.`];
  if (existsSync(id)) parts.push(`## IDENTITY\n${readFileSync(id, 'utf8')}`);
  if (existsSync(usr)) parts.push(`## USER\n${readFileSync(usr, 'utf8')}`);
  // Pull in CONTEXT files for richer prompt
  const ctxDir = home.layer('CONTEXT');
  if (existsSync(ctxDir)) {
    for (const f of readdirSync(ctxDir)) {
      if (f.endsWith('.md') && !f.startsWith('.')) {
        parts.push(`## CONTEXT/${f}\n${readFileSync(join(ctxDir, f), 'utf8')}`);
      }
    }
  }
  return parts.join('\n\n');
}

export async function runGateway(opts: { port?: number }): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const config = loadAgentConfig(home);
  const env = loadAgentEnv(home);
  const logger = createLogger({ home });

  const cortex = bindCortex(env.CORTEX_AGENT_ID, env.MERIDIAN_CORTEX_URL);
  const router = new ProviderRouter(env);

  // Boot-time CORTEX health check. If the backend is unreachable at start,
  // log a clear warning so the operator knows recall + encode will fail
  // until CORTEX comes online. Don't refuse to boot — the gateway is still
  // useful for setup commands, doctor, etc. when CORTEX is down. But the
  // first turn will be louder about why memory isn't working.
  try {
    const bootHealth = await Promise.race([
      cortex.health(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cortex health probe timed out (3s)')), 3000),
      ),
    ]);
    if (bootHealth.status === 'ok') {
      logger.info({ event: 'cortex.health', status: 'ok', url: cortex.baseUrl, msg: 'CORTEX backend reachable' });
    } else {
      logger.warn({
        event: 'cortex.health',
        status: bootHealth.status,
        url: cortex.baseUrl,
        msg: `CORTEX backend reports degraded/down at boot — recall + encode may fail`,
      });
    }
  } catch (err) {
    logger.warn({
      event: 'cortex.health',
      status: 'unreachable',
      url: cortex.baseUrl,
      err: (err as Error).message,
      msg: 'CORTEX backend unreachable at boot — recall + encode will fail until it comes online',
    });
  }

  // Memory provider seam (Phase 4). MERIDIAN_MEMORY_PROVIDER=quartz lights
  // the proprietary recall pipeline up on every conversation turn through
  // the gateway (Telegram, voice, VAPI, web channels). Encode + dream still
  // use CortexBind directly because they delegate-equivalently in both
  // providers; only recall has provider-distinct behavior today.
  const memorySelection = await createMemoryProvider({
    env,
    router,
    cortex,
    embeddedDbPath: join(home.layer('MEMORY'), 'embedded.jsonl'),
    log: (level, msg) => {
      if (level === 'warn') logger.warn({ event: 'memory.provider.fallback', msg });
      else logger.info({ event: 'memory.provider.selected', msg }, msg);
    },
  });

  // Tool surface: builtins + v2 skill tools + MCP tools, assembled in one
  // place shared with the REPL (src/agent/tool-surface.ts).
  const surface = await buildToolSurface({ home, config, env, cortex, logger, router, memory: memorySelection.provider });
  const { tools, skillToolNames, skills, vault, verificationChecks, provenanceSigner } = surface;

  // Voice session guard — passphrase-gated unlock for the public voice line.
  // Vault stores the phrase; transcript scanner strips it before the model sees it;
  // executeTool checks unlock state per-callId before running privileged tools.
  const voiceGuard = new VoiceSessionGuard(vault, logger);

  // ── Pre-build the runtime loadout file BEFORE reading the system base ──
  // The loadout is a CONTEXT file the agent reads on every turn. Writing it
  // here ensures the FIRST systemBase already includes it (so the very first
  // turn after boot knows the full loadout, no warmup miss).
  try {
    const { writeLoadoutFile } = await import('../agent/loadout.js');
    const { loadAutomationDefs } = await import('../automations/manager.js');
    const cortexStats = await cortex.stats().catch(() => undefined);
    writeLoadoutFile({
      home,
      config,
      env,
      skills,
      automations: loadAutomationDefs(home),
      builtinToolNames: surface.builtinToolNames,
      mcpTools: surface.mcpStatus.flatMap((st) => st.tools.map((t) => ({ name: t, server: st.server }))),
      cortexStats: cortexStats ?? undefined,
    });
  } catch (err) {
    logger.warn({ msg: 'loadout write failed', err });
  }

  const systemBase = readSystemBase(home, config.agent.name);

  // DreamWeaver consolidates CORTEX memory; the embedded provider has no
  // consolidation pipeline, so skip it in zero-config mode.
  const dream = new DreamWeaver({ cortex, config: config.dream, logger });
  if (memorySelection.selected !== 'embedded') dream.start();

  // ── Persistent session store ──
  // Every turn writes to ~/.meridian/<agent>/state.db so conversations
  // survive gateway restarts. The store is also how we look up an
  // operator's most recent session across channel boundaries.
  const store = new SessionStore(home);

  // ── Cross-channel operator-keyed session cache ──
  // The session key is `op:<operator-id>` for known operators (one
  // conversation per human, regardless of which channel they reach in
  // through). Unknown callers fall back to `unknown:<channel>:<from>`
  // so anonymous threads stay sandboxed.
  //
  // In-memory cache for sub-second turn lookup; backed by SessionStore
  // so a fresh gateway boot resumes seamlessly.
  const IDLE_MS = 60 * 60 * 1000; // 1 hour in-memory; store keeps 7 days
  const sessions = new Map<string, { convo: Conversation; lastSeen: number; opLabel: string }>();

  function buildConvo(channel: ChannelKind, sessionId: string, opLabel: string): Conversation {
    // Try to resume from disk so history survives restarts.
    const resume = store.loadSession(sessionId) ?? undefined;
    const convo = new Conversation({
      config,
      cortex: memorySelection.provider,
      router, logger,
      systemBase, channel, tools,
      skillToolNames,
      mcpGate: surface.mcpGate,
      verificationChecks,
      provenanceSigner,
      resume,
      store,
    });
    if (!resume) {
      store.startSession({
        id: sessionId,
        agentSlug: home.agentSlug,
        title: opLabel,
        createdAt: new Date().toISOString(),
        turns: [],
        operatorId: opLabel,
      } as Parameters<typeof store.startSession>[0]);
    }
    return convo;
  }

  function getSession(channel: ChannelKind, from: string): {
    convo: Conversation;
    sessionId: string;
    operatorLabel: string;
  } {
    const op = resolveOperator(config, channel, from);
    const sessionId = op.source === 'config' ? operatorSessionId(op.id) : `op:${op.id}`;
    const opLabel = op.source === 'config' ? op.id : `unknown(${channel}:${from || 'anon'})`;
    const now = Date.now();
    const existing = sessions.get(sessionId);
    if (existing && now - existing.lastSeen < IDLE_MS) {
      existing.lastSeen = now;
      return { convo: existing.convo, sessionId, operatorLabel: existing.opLabel };
    }
    const convo = buildConvo(channel, sessionId, opLabel);
    sessions.set(sessionId, { convo, lastSeen: now, opLabel });
    if (op.source === 'config') {
      logger.info({ msg: 'session resolved', operator: op.id, channel, sessionId });
    } else {
      logger.info({ msg: 'unknown caller', channel, from, sessionId });
    }
    return { convo, sessionId, operatorLabel: opLabel };
  }

  // Persist each turn so cross-channel resume works after restart.
  async function turn(
    channel: ChannelKind,
    from: string,
    text: string,
    sendOpts?: Parameters<Conversation['send']>[1],
  ): Promise<string> {
    const { convo, sessionId } = getSession(channel, from);
    const startedTurns = convo.historyCount; // approximate index
    const t = await convo.send(text, sendOpts);
    // Append BOTH user + assistant turns to the store with monotonic idx
    // so loadSession returns them in send order.
    const userTurnId = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}u`;
    const userTurn: MeridianTurn = {
      id: userTurnId,
      sessionId,
      role: 'user',
      content: text,
      channel,
      ts: new Date(t.ts ? Date.parse(t.ts) - 1 : Date.now() - 10).toISOString(),
    };
    const assistantTurn: MeridianTurn = { ...t, sessionId };
    try {
      store.appendTurn(userTurn, startedTurns);
      store.appendTurn(assistantTurn, startedTurns + 1);
    } catch (err) {
      logger.warn({ msg: 'session persist failed', err });
    }
    return t.content;
  }

  // Idle sweeper — once a minute, drop in-memory sessions older than IDLE_MS.
  // The store keeps them on disk; next message reloads.
  setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [k, v] of sessions) {
      if (v.lastSeen < cutoff) sessions.delete(k);
    }
  }, 60_000).unref();

  // Channel registry — ProactiveSentinel uses this to push briefs.
  const channelMap = new Map<string, ChannelAdapter>();

  // ── Telegram channel — trusted chat ID, full sensitivity ──
  // Constructed first so VapiChannel can reach it for end-of-call handoffs.
  let telegram: TelegramChannel | undefined;
  if (env.TELEGRAM_BOT_TOKEN) {
    telegram = new TelegramChannel({
      token: env.TELEGRAM_BOT_TOKEN,
      defaultChatId: env.TELEGRAM_DEFAULT_CHAT_ID,
      envPath: home.envPath,
      logger,
    });
    await telegram.start(undefined, {
      onInbound: async (m) => turn('telegram', m.from, m.text),
    });
    channelMap.set('telegram', telegram as unknown as ChannelAdapter);
    console.log(colors.ok('telegram channel started'));
  }

  // ── Voice channel — public-only sensitivity, sacred-leak block check ──
  // Voice tools the agent can invoke directly from VAPI. Strictly limited:
  // a phone caller should never reach `bash`/`write`/`read`. telegram_dm
  // unlocks cross-channel handoff; cortex_recall surfaces relevant history
  // mid-call; cortex_encode lets the agent durably bookmark a commitment
  // from a caller in the moment instead of waiting for the end-of-call
  // rollup. Anything else stays server-only.
  const VOICE_TOOL_ALLOW = new Set([
    'telegram_dm',
    'cortex_recall',
    'cortex_encode',
    'cortex_dream',
  ]);
  // All four privileged tools require an unlocked voice session. The public
  // voice line is anonymous; without unlock, a caller could DM the operator,
  // pollute memory, or pull internal context. Operator unlocks by speaking
  // the configured passphrase early in the call.
  const VOICE_TOOL_REQUIRES_UNLOCK = new Set([
    'telegram_dm',
    'cortex_recall',
    'cortex_encode',
    'cortex_dream',
  ]);
  let vapi: VapiChannel | undefined;
  if (env.VAPI_API_KEY) {
    vapi = new VapiChannel({
      logger,
      webhookSecret: env.VAPI_WEBHOOK_SECRET,
      vapiApiKey: env.VAPI_API_KEY,
      phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
      assistantId: env.VAPI_ASSISTANT_ID,
      cortex,
      voiceGuard,
      telegramDM: telegram && env.TELEGRAM_DEFAULT_CHAT_ID
        ? async (text: string) => {
            await telegram!.send({ to: env.TELEGRAM_DEFAULT_CHAT_ID!, text });
          }
        : undefined,
      executeTool: async (name, args, ctx) => {
        if (!VOICE_TOOL_ALLOW.has(name)) {
          throw new Error(`tool '${name}' is not whitelisted for voice`);
        }
        if (VOICE_TOOL_REQUIRES_UNLOCK.has(name) && !voiceGuard.isUnlocked(ctx.callId)) {
          // Soft-fail: return a structured response the model can speak naturally
          // ("I'm in public mode and can't do that without authorization").
          // Do NOT throw — throwing fires the error path on VAPI's side and
          // the model loses the ability to surface it to the caller smoothly.
          return {
            error: 'voice_session_locked',
            message: voiceGuard.isConfigured()
              ? 'This call is in public mode. The caller must speak the passphrase to unlock privileged tools.'
              : 'Voice passphrase not configured on this agent. Run `meridian voice passphrase` to set one.',
          };
        }
        const t = (tools as Record<string, { execute?: (a: unknown) => Promise<unknown> }>)[name];
        if (!t?.execute) {
          throw new Error(`tool '${name}' not loaded`);
        }
        return t.execute(args);
      },
    });
    await vapi.start(undefined, {
      onInbound: async (m) => turn('voice', m.from || 'anon', m.text),
    });
    channelMap.set('voice', vapi as unknown as ChannelAdapter);
    console.log(colors.ok('voice channel armed'));
  }

  // ── Proactive sentinel — morning brief + optional nudges ──
  // The thing that makes a Meridian agent a partner instead of a chatbot.
  // Scheduled CORTEX recalls compose a brief and push it to the operator's
  // primary channel without being asked.
  const sentinel = new ProactiveSentinel({
    config,
    cortex,
    router,
    logger,
    channels: channelMap,
    agentName: config.agent.name,
    systemBase,
  });
  sentinel.start();
  if (config.proactive?.enabled) {
    console.log(colors.ok('proactive sentinel armed'));
  }

  // ── Automation engine — runs the AUTOMATIONS layer ──
  // Each *.cron file in the agent's home becomes a scheduled job that
  // composes a turn against CORTEX, encodes the output as memory, and
  // optionally pushes to the operator's primary channel.
  const automations = new AutomationManager({
    home,
    config,
    cortex,
    router,
    logger,
    systemBase,
    channels: channelMap,
    tools,
  });
  const autoDefs = automations.start();
  if (autoDefs.length > 0) {
    console.log(colors.ok(`automations armed: ${autoDefs.length} job(s)`));
    for (const d of autoDefs) {
      console.log(colors.muted(`  • ${d.name}  ${d.schedule}`));
    }
  }


  // ── Inbox watcher — drop a file in MEMORY/inbox/ and the agent ingests it ──
  // Multimodal capability: PDFs, markdown, text, image stubs all flow into
  // CORTEX automatically. After ingest the file is renamed to .processed
  // so re-runs don't double-encode.
  const inbox = join(home.layer('MEMORY'), 'inbox');
  try {
    mkdirSync(inbox, { recursive: true });
  } catch {
    /* dir exists */
  }
  void watchInbox(cortex, inbox, { logger });
  console.log(colors.ok(`inbox watcher armed at ${inbox}`));

  // Gateway HTTP server (used by VAPI webhook + chat API).
  // The HTTP /chat path now also flows through the operator-keyed session
  // cache so an authenticated /chat call from the operator joins the same
  // conversation as their voice + Telegram threads.
  const httpConvoFacade = {
    sessionId: 'gateway-http',
    historyCount: 0,
    send: async (text: string, sendOpts?: Parameters<Conversation['send']>[1]) => {
      const reply = await turn('gateway', 'http', text, sendOpts);
      return {
        id: `t_${Date.now().toString(36)}`,
        sessionId: 'gateway-http',
        role: 'assistant' as const,
        content: reply,
        channel: 'gateway' as const,
        ts: new Date().toISOString(),
      };
    },
  } as unknown as Conversation;
  const port = opts.port ?? config.channels.gateway.port ?? env.MERIDIAN_GATEWAY_PORT;
  await startGateway({
    port,
    token: env.MERIDIAN_GATEWAY_TOKEN,
    logger,
    conversation: httpConvoFacade,
    vapi,
    sentinel,
    automations,
  });

  console.log(colors.ok(`Meridian gateway live on :${port} for agent ${slug}`));
  console.log(colors.muted(`  channels: ${[
    'cli (REPL)',
    env.TELEGRAM_BOT_TOKEN ? 'telegram (gated)' : null,
    vapi ? 'voice (VAPI webhook ready)' : null,
    'http /chat',
  ].filter(Boolean).join(', ')}`));

  // Block forever
  await new Promise(() => {});
}
