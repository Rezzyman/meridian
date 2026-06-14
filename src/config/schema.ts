/**
 * Meridian config schemas. Single source of truth for runtime + intake + agent OS layers.
 * Every config crosses through zod before reaching code paths.
 */

import { z } from 'zod';

// ─── Per-agent isolation triad (env-loaded) ────────────────────────────────────
export const AgentEnvSchema = z
  .object({
  MERIDIAN_AGENT: z.string().min(1, 'agent slug required'),
  CORTEX_AGENT_ID: z.string().min(1),
  // NEON + VOYAGE power the CORTEX/Quartz backends. They are OPTIONAL so the
  // zero-config embedded provider (MERIDIAN_MEMORY_PROVIDER=embedded) boots
  // with no external keys at all; a superRefine below still requires them for
  // the cortex/quartz providers.
  NEON_DATABASE_URL: z.string().url('Neon Postgres URL required').optional(),
  VOYAGE_API_KEY: z.string().min(20, 'Voyage AI key required for embeddings').optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  // ROUTEXOR — ATERNA's BYOK zero-markup model router (recommended default,
  // never mandatory). OpenAI-compatible; BASE_URL overrides the endpoint.
  ROUTEXOR_API_KEY: z.string().optional(),
  ROUTEXOR_BASE_URL: z.string().url().optional(),

  // VAPI voice channel (optional but headline)
  VAPI_API_KEY: z.string().optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),
  VAPI_ASSISTANT_ID: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_DEFAULT_CHAT_ID: z.string().optional(),

  // Slack (Events API): bot token (xoxb-…) + the app signing secret.
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  // Discord (Interactions): the app public key (Ed25519) + application id.
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),

  // WhatsApp (Meta Cloud API): phone-number id + access token + app secret +
  // the webhook verify token.
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // Matrix (client-server API): the homeserver, a bot access token, and the
  // bot's own MXID (to ignore its own messages). Polls /sync — no webhook.
  MATRIX_HOMESERVER_URL: z.string().url().optional(),
  MATRIX_ACCESS_TOKEN: z.string().optional(),
  MATRIX_USER_ID: z.string().optional(),

  // SMS (Twilio): account SID + auth token + the agent's Twilio number, plus
  // the exact public webhook URL Twilio POSTs to (needed for signature checks).
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_WEBHOOK_URL: z.string().url().optional(),

  // Gateway
  MERIDIAN_GATEWAY_TOKEN: z.string().optional(),
  MERIDIAN_GATEWAY_PORT: z.coerce.number().int().default(18889),

  // CORTEX server URL (used by CortexBind)
  MERIDIAN_CORTEX_URL: z.string().url().optional(),

  // Memory provider selection. "cortex" is the open-source default;
  // "quartz" lazy-loads @aterna/quartz and falls back to cortex on failure;
  // "embedded" is the zero-config local provider (no server, no keys).
  MERIDIAN_MEMORY_PROVIDER: z.enum(['cortex', 'quartz', 'embedded']).default('cortex'),

  // ngrok auth token (optional, for tunnel automation)
  NGROK_AUTHTOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // CORTEX + Quartz need the dedicated Neon DB + Voyage key; embedded needs
    // neither. Enforce the triad only when the active provider uses it.
    if (env.MERIDIAN_MEMORY_PROVIDER !== 'embedded') {
      if (!env.NEON_DATABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NEON_DATABASE_URL'],
          message: 'Neon Postgres URL required (or set MERIDIAN_MEMORY_PROVIDER=embedded)',
        });
      }
      if (!env.VOYAGE_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['VOYAGE_API_KEY'],
          message: 'Voyage AI key required (or set MERIDIAN_MEMORY_PROVIDER=embedded)',
        });
      }
    }
  });

export type AgentEnv = z.infer<typeof AgentEnvSchema>;

// ─── Provider config (runtime) ─────────────────────────────────────────────────
export const ProviderRefSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'groq', 'ollama', 'routexor']),
  model: z.string(),
  alias: z.string().optional(),
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

export const ModelChainSchema = z.object({
  primary: z.string(), // e.g. "routexor/anthropic/claude-haiku-4.5"
  fallbacks: z.array(z.string()).default([]),
  smartRouting: z
    .object({
      enabled: z.boolean().default(true),
      maxSimpleChars: z.number().default(200),
      maxSimpleWords: z.number().default(35),
      cheapModel: z.string().default('routexor/anthropic/claude-haiku-4.5'),
    })
    .default({
      enabled: true,
      maxSimpleChars: 200,
      maxSimpleWords: 35,
      cheapModel: 'routexor/anthropic/claude-haiku-4.5',
    }),
});
export type ModelChain = z.infer<typeof ModelChainSchema>;

// ─── Heartbeat & active hours ──────────────────────────────────────────────────
export const HeartbeatSchema = z.object({
  enabled: z.boolean().default(true),
  every: z.string().default('2h'),
  activeHours: z.object({
    start: z.string().default('06:00'),
    end: z.string().default('23:30'),
  }),
  model: z.string().default('routexor/anthropic/claude-haiku-4.5'),
  target: z.string().default('last'),
  ackMaxChars: z.number().default(500),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// ─── Channels ──────────────────────────────────────────────────────────────────
export const ChannelConfigSchema = z.object({
  cli: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      defaultChatId: z.string().optional(),
    })
    .default({ enabled: false }),
  slack: z
    .object({
      enabled: z.boolean().default(false),
      /** Optional channel-id allowlist; empty = any channel the bot is in. */
      allowedChannels: z.array(z.string()).default([]),
    })
    .default({ enabled: false, allowedChannels: [] }),
  discord: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  whatsapp: z
    .object({
      enabled: z.boolean().default(false),
      /** Optional sender allowlist (wa_id / phone); empty = anyone. */
      allowedNumbers: z.array(z.string()).default([]),
    })
    .default({ enabled: false, allowedNumbers: [] }),
  matrix: z
    .object({
      enabled: z.boolean().default(false),
      /** Optional room-id allowlist; empty = any room the bot has joined. */
      allowedRooms: z.array(z.string()).default([]),
    })
    .default({ enabled: false, allowedRooms: [] }),
  sms: z
    .object({
      enabled: z.boolean().default(false),
      /** Optional sender allowlist (E.164); empty = anyone. */
      allowedNumbers: z.array(z.string()).default([]),
    })
    .default({ enabled: false, allowedNumbers: [] }),
  vapi: z
    .object({
      enabled: z.boolean().default(false),
      phoneNumberId: z.string().optional(),
      assistantId: z.string().optional(),
      voicePersona: z
        .enum(['warm_professional', 'friendly_casual', 'authoritative', 'energetic', 'calm_concierge'])
        .default('warm_professional'),
    })
    .default({ enabled: false }),
  gateway: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().default(18889),
    })
    .default({ enabled: false }),
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

// ─── Dream cycle config ────────────────────────────────────────────────────────
export const DreamConfigSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().default('0 2 * * *'), // 02:00 nightly
  mode: z.enum(['full', 'first-deploy', 'consolidate-only']).default('full'),
  inProcess: z.boolean().default(true),
});
export type DreamConfig = z.infer<typeof DreamConfigSchema>;

// ─── Per-agent tool allowlist ──────────────────────────────────────────────────
// Tools an agent can actually call, scoped by channel. The chat surface
// (voice, telegram, gateway HTTP) defaults to a safe conversational set;
// the REPL defaults to the full power-user set.
//
// Why this exists: Sonnet 4.6 will reach for `bash` on any "look up X"
// prompt and hallucinate results when it returns empty. A chat agent
// should never have shell. A DevOps agent on REPL might want it. This
// schema makes that an explicit per-agent decision instead of a hardcoded
// default.
// Pure, side-effect-free helpers (hash/base64/time/HTML-extract) are safe on
// every surface. `http_request` makes real network egress (SSRF-guarded but
// still POST-capable), so it stays a CLI power-user default — operators opt
// chat agents in explicitly.
const SAFE_UTILITIES = [
  'extract_text',
  'hash_text',
  'base64_transform',
  'current_time',
] as const;
const CHAT_SAFE_DEFAULT = [
  'web_fetch',
  'voice_status',
  'cortex_dream',
  'telegram_dm',
  ...SAFE_UTILITIES,
] as const;
const CLI_SAFE_DEFAULT = [
  'web_fetch',
  'voice_status',
  'cortex_dream',
  'telegram_dm',
  'bash',
  'read',
  'write',
  'list_dir',
  'glob_files',
  'search_files',
  'edit_file',
  'run_code',
  'delegate',
  'http_request',
  ...SAFE_UTILITIES,
] as const;
export const ToolsConfigSchema = z.object({
  chat: z.array(z.string()).default([...CHAT_SAFE_DEFAULT]),
  cli: z.array(z.string()).default([...CLI_SAFE_DEFAULT]),
});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export const TOOLS_CHAT_DEFAULT = CHAT_SAFE_DEFAULT;
export const TOOLS_CLI_DEFAULT = CLI_SAFE_DEFAULT;

// ─── Delegation (sub-agents) ───────────────────────────────────────────────────
// The `delegate` built-in runs a scoped sub-turn: constrained toolset, its
// own output-token budget, its own (shorter) timeout, no memory encode by
// default. Every limit here is a HARD bound enforced by the runtime — a
// model cannot talk its way past them.
export const DelegationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** How many levels may delegate. 1 = the root agent can spawn a child;
   *  the child cannot re-delegate. Bounded at 4 — fan-out is a feature,
   *  recursion is an outage. */
  maxDepth: z.number().int().min(1).max(4).default(1),
  /** Output-token cap per sub-turn (streamText maxTokens). */
  maxOutputTokens: z.number().int().min(256).max(32000).default(4000),
  /** Wall-clock cap per sub-turn. */
  timeoutSec: z.number().int().min(5).max(600).default(120),
  /** Tools grantable to a child when the parent doesn't name any. */
  childTools: z.array(z.string()).default(['web_fetch', 'read']),
  /** Encode child turns into memory. Off by default: a research fan-out
   *  shouldn't pollute the agent's episodic memory with scratch work. */
  encodeSubTurns: z.boolean().default(false),
});
export type DelegationConfig = z.infer<typeof DelegationConfigSchema>;

// ─── Proactive sentinel config ─────────────────────────────────────────────────
// What turns the agent from "responsive" into "real partner". Scheduled
// recall passes that surface things on the operator's behalf without being
// asked. Off by default for new agents; explicitly enabled per-agent.
export const ProactiveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  morningBriefSchedule: z.string().default('0 7 * * *'), // 07:00 local daily
  hourlyNudgesEnabled: z.boolean().default(false),
  hourlyNudgeSchedule: z.string().default('0 9-21 * * *'), // 09:00..21:00 hourly
});
export type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;

// ─── Operator (the human the agent answers to) ────────────────────────────────
// One canonical operator per agent. Used to stitch sessions across channels —
// a voice call from a known number, a Telegram message from a trusted chat ID,
// and a REPL invocation by a known OS user all resolve to the same operator
// and share one continuous Conversation. This is what makes Meridian's
// agents feel like real partners across surfaces, not chatbots-per-channel.
export const OperatorConfigSchema = z.object({
  id: z.string().min(1).default('primary'),
  name: z.string().optional(),
  email: z.string().email().optional(),
  channels: z
    .object({
      telegram: z.array(z.string()).default([]),
      voice: z.array(z.string()).default([]),
      cli: z.array(z.string()).default([]),
    })
    .default({ telegram: [], voice: [], cli: [] }),
  /**
   * Sacred-topic policy: content the agent must never surface on an
   * untrusted channel (the public voice line, external callers). The
   * operator owns this list — `meridian onboard` populates it. The runtime
   * ships ZERO hardcoded names; an operator's private entities live only in
   * their own config, never in framework source.
   *
   *   topics   — plain phrases ("my kids' school", a family name); matched
   *              case-insensitively as whole words
   *   patterns — advanced: raw regex sources for operators who want them
   *   refusal  — what the agent says instead of leaking (defaults generic)
   */
  sensitivity: z
    .object({
      sacredTopics: z.array(z.string()).default([]),
      sacredPatterns: z.array(z.string()).default([]),
      refusal: z.string().optional(),
    })
    .optional(),
});
export type OperatorConfig = z.infer<typeof OperatorConfigSchema>;

// ─── Top-level agent config (config.yaml) ──────────────────────────────────────
export const AgentConfigSchema = z.object({
  agent: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    role: z.string().default('assistant'),
    template: z.string().optional(), // e.g. "chief_of_staff"
    inheritsFrom: z.string().optional(), // hub agent slug
    maxTurns: z.number().int().default(60),
    gatewayTimeoutSec: z.number().int().default(1800),
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  }),
  operator: OperatorConfigSchema.optional(),
  models: ModelChainSchema,
  channels: ChannelConfigSchema,
  heartbeat: HeartbeatSchema,
  dream: DreamConfigSchema,
  proactive: ProactiveConfigSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  delegation: DelegationConfigSchema.optional(),
  cortex: z.object({
    agentId: z.string(),
    recallTopK: z.number().int().default(8),
    encodeOnTurn: z.boolean().default(true),
    valenceInference: z.boolean().default(true),
    /**
     * Defense-in-depth for memory poisoning. The always-on regex screen
     * catches explicit/lexical directives for free; this enables the optional
     * LLM-judge second pass that also catches non-lexicon languages, encoded
     * payloads, and fact-shaped semantic directives — at the cost of a model
     * call on recall turns that surface untrusted memories. Off by default.
     */
    memoryLlmJudge: z.boolean().default(false),
    /**
     * Provenance trust policy for the memory-poisoning screen.
     *   'prefix' (default) — trust is decided by the channel-label heuristic
     *     (isUntrustedProvenance). Zero-config, but a path that can write a
     *     trusted-looking source string can launder a directive into trust.
     *   'signed' — trust requires a valid per-agent HMAC signature minted at
     *     encode time (provenance.ts). A spoofed channel label confers nothing,
     *     which closes the provenance-laundering attack family. Requires the
     *     runtime to sign its own encodes; memories written before enabling it
     *     (or by external surfaces) are treated as untrusted.
     */
    provenanceTrust: z.enum(['prefix', 'signed']).default('prefix'),
  }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ─── Seven-layer AgentOS spine ─────────────────────────────────────────────────
export const AgentOSLayerName = z.enum([
  'IDENTITY',
  'CONTEXT',
  'SKILLS',
  'MEMORY',
  'CONNECTIONS',
  'VERIFICATION',
  'AUTOMATIONS',
]);
export type AgentOSLayerName = z.infer<typeof AgentOSLayerName>;

export const ContextFileFrontmatterSchema = z.object({
  title: z.string(),
  owner: z.string().default('user'),
  lastUpdated: z.string(), // ISO date
  stalenessThresholdDays: z.number().int().default(30),
  tags: z.array(z.string()).default([]),
});

export const SkillManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  category: z.string().default('general'),
  trigger: z.string().optional(),
  sources: z.array(z.string()).default([]),
  output_format: z.string().optional(),
  version: z.string().default('0.1.0'),
  runtime: z.enum(['markdown', 'ts', 'py', 'sh']).default('markdown'),
  entrypoint: z.string().optional(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ─── Skill manifest v2 (manifest.yaml) ─────────────────────────────────────────
// Skills with executable code ship a manifest.yaml alongside SKILL.md. The
// manifest declares: required env vars, required vault entries (secrets),
// required OAuth flow, passphrase guard config, and the named tools the
// skill provides. This is what makes a skill installable, configurable,
// and walkthrough-aware.
export const SkillManifestV2Schema = z.object({
  name: z.string().min(1),
  version: z.string().default('0.1.0'),
  description: z.string(),
  category: z.string().default('general'),
  requires: z
    .object({
      env: z.array(z.string()).default([]),
      vault: z.array(z.string()).default([]),
      oauth: z
        .object({
          provider: z.string(),
          scopes: z.array(z.string()).default([]),
          authUrl: z.string().url().optional(),
          tokenUrl: z.string().url().optional(),
        })
        .optional(),
    })
    .default({ env: [], vault: [] }),
  passphrase: z
    .object({
      required: z.boolean().default(false),
      sessionWindowMinutes: z.number().int().default(30),
      sessionWindowConfigurable: z.boolean().default(true),
    })
    .optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        requiresPassphrase: z.boolean().default(false),
      }),
    )
    .default([]),
  setup: z.string().optional(), // path to setup walkthrough markdown
});
export type SkillManifestV2 = z.infer<typeof SkillManifestV2Schema>;

export const VerificationCheckSchema = z.object({
  name: z.string().min(1),
  skill: z.string().min(1),
  trigger: z.enum(['always', 'on_output', 'on_tool_use']).default('on_output'),
  helper: z.enum([
    'tone_match',
    'factual_check',
    'numeric_validation',
    'policy_compliance',
    'pii_redaction',
    'custom',
  ]),
  severity: z.enum(['block', 'warn']).default('warn'),
  config: z.record(z.unknown()).default({}),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const AutomationJobSchema = z.object({
  name: z.string().min(1),
  schedule: z.string(), // cron expression
  prompt: z.string(),
  mode: z.enum(['draft', 'direct']).default('draft'),
  requiresApproval: z.boolean().default(true),
  audit: z.boolean().default(true),
  trustGraduation: z
    .object({
      minRuns: z.number().int().default(10),
      minApprovalRate: z.number().default(0.95),
    })
    .optional(),
});
export type AutomationJob = z.infer<typeof AutomationJobSchema>;

export const ConnectionConfigSchema = z.object({
  system: z.string(), // calendar | inbox | slack | jira | salesforce | custom
  mode: z.enum(['read', 'read-write']).default('read'),
  audit: z.boolean().default(true),
  scopes: z.array(z.string()).default([]),
  secret_ref: z.string().optional(),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

// ─── 10-question intake (drives meridian deploy) ───────────────────────────────
export const IntakeSchema = z.object({
  q1_business_name: z.string().min(1),
  q2_business_one_liner: z.string().min(10),
  q3_agent_name: z.string().min(1),
  q4_agent_role: z.enum([
    'receptionist',
    'sales_qualifier',
    'support_triage',
    'booking_concierge',
    'outbound_caller',
    'chief_of_staff',
    'custom',
  ]),
  q5_phone_strategy: z.enum(['new_vapi_number', 'port_existing', 'no_voice']),
  q6_voice_persona: z.enum([
    'warm_professional',
    'friendly_casual',
    'authoritative',
    'energetic',
    'calm_concierge',
  ]),
  q7_business_hours: z.string(),
  q8_knowledge_seed: z.string(),
  q9_handoff_human: z.object({
    name: z.string(),
    phone: z.string(),
    email: z.string().email(),
    triggers: z.array(z.string()),
  }),
  q10_extra_channels: z.array(z.enum(['telegram', 'slack', 'sms', 'email', 'none'])).default([]),
});
export type Intake = z.infer<typeof IntakeSchema>;

// ─── Defaults helper ───────────────────────────────────────────────────────────
export const defaultAgentConfig = (slug: string, name: string): AgentConfig => ({
  agent: {
    slug,
    name,
    role: 'assistant',
    maxTurns: 60,
    gatewayTimeoutSec: 1800,
    reasoningEffort: 'medium',
  },
  models: {
    primary: 'routexor/anthropic/claude-haiku-4.5',
    fallbacks: [
      'routexor/anthropic/claude-sonnet-4.6',
      'ollama/qwen2.5:14b',
      'ollama/hermes3:8b',
    ],
    smartRouting: {
      enabled: true,
      maxSimpleChars: 200,
      maxSimpleWords: 35,
      cheapModel: 'routexor/anthropic/claude-haiku-4.5',
    },
  },
  channels: {
    cli: { enabled: true },
    telegram: { enabled: false },
    slack: { enabled: false, allowedChannels: [] },
    discord: { enabled: false },
    whatsapp: { enabled: false, allowedNumbers: [] },
    matrix: { enabled: false, allowedRooms: [] },
    sms: { enabled: false, allowedNumbers: [] },
    vapi: { enabled: false, voicePersona: 'warm_professional' },
    gateway: { enabled: false, port: 18889 },
  },
  heartbeat: {
    enabled: true,
    every: '2h',
    activeHours: { start: '06:00', end: '23:30' },
    model: 'routexor/anthropic/claude-haiku-4.5',
    target: 'last',
    ackMaxChars: 500,
  },
  dream: { enabled: true, schedule: '0 2 * * *', mode: 'full', inProcess: true },
  cortex: {
    agentId: slug,
    recallTopK: 8,
    encodeOnTurn: true,
    valenceInference: true,
    memoryLlmJudge: false,
    provenanceTrust: 'prefix',
  },
});
