/**
 * Loads and validates the per-agent .env into a typed AgentEnv.
 * Enforces the per-agent isolation triad (Neon DB + Voyage + a model key).
 */

import { existsSync, readFileSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import type { AgentEnv } from './schema.js';
import { AgentEnvSchema } from './schema.js';
import type { MeridianHome } from './home.js';

export function loadAgentEnv(home: MeridianHome): AgentEnv {
  if (existsSync(home.envPath)) {
    dotenvConfig({ path: home.envPath, override: false });
  }
  const candidate = {
    MERIDIAN_AGENT: process.env.MERIDIAN_AGENT ?? home.agentSlug,
    CORTEX_AGENT_ID: process.env.CORTEX_AGENT_ID ?? home.agentSlug,
    NEON_DATABASE_URL: process.env.NEON_DATABASE_URL,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    ROUTEXOR_API_KEY: process.env.ROUTEXOR_API_KEY,
    ROUTEXOR_BASE_URL: process.env.ROUTEXOR_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    VAPI_API_KEY: process.env.VAPI_API_KEY,
    VAPI_PHONE_NUMBER_ID: process.env.VAPI_PHONE_NUMBER_ID,
    VAPI_ASSISTANT_ID: process.env.VAPI_ASSISTANT_ID,
    VAPI_WEBHOOK_SECRET: process.env.VAPI_WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_DEFAULT_CHAT_ID: process.env.TELEGRAM_DEFAULT_CHAT_ID,
    // Webhook + client channels. These were silently dropped before: the
    // gateway gates each channel on env.<KEY>, but loadAgentEnv never copied
    // them out of process.env, so Slack/Discord/WhatsApp never started even
    // with keys set. Propagate them (Matrix included).
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    MATRIX_HOMESERVER_URL: process.env.MATRIX_HOMESERVER_URL,
    MATRIX_ACCESS_TOKEN: process.env.MATRIX_ACCESS_TOKEN,
    MATRIX_USER_ID: process.env.MATRIX_USER_ID,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
    TWILIO_WEBHOOK_URL: process.env.TWILIO_WEBHOOK_URL,
    MERIDIAN_GATEWAY_TOKEN: process.env.MERIDIAN_GATEWAY_TOKEN,
    MERIDIAN_GATEWAY_PORT: process.env.MERIDIAN_GATEWAY_PORT,
    MERIDIAN_CORTEX_URL: process.env.MERIDIAN_CORTEX_URL,
    MERIDIAN_MEMORY_PROVIDER: process.env.MERIDIAN_MEMORY_PROVIDER,
    NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
  };
  return AgentEnvSchema.parse(candidate);
}

/**
 * Collect env values from process.env for the keys declared by skills via
 * `manifest.yaml#requires.env[]`. Returns a plain map. The runtime merges
 * this on top of the typed AgentEnv when constructing SkillToolContext.env
 * so skills can read their declared keys without core schema edits.
 *
 * Why this exists: skills declare their own env requirements (LIMITLESS_API_KEY,
 * SLACK_BOT_TOKEN, NOTION_TOKEN, etc.). Encoding every such key in the typed
 * AgentEnvSchema couples core to specific skills and silently drops keys the
 * loader forgets to propagate (we hit this twice: MERIDIAN_MEMORY_PROVIDER
 * regression and LIMITLESS_API_KEY). Skill manifests are now the source of
 * truth; this helper closes the loop at construction.
 */
export function collectSkillEnv(declaredKeys: Iterable<string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of declaredKeys) {
    out[k] = process.env[k];
  }
  return out;
}

/** Zero-config .env: embedded local memory, ollama by default — no external
 *  servers, no API keys required. The 60-second quickstart. */
export function embeddedEnvFileTemplate(slug: string): string {
  return `# Meridian agent env: ${slug} (zero-config / embedded memory)
# No CORTEX server, no Neon, no Voyage. Memory persists locally in
# MEMORY/embedded.jsonl. Upgrade to CORTEX/Quartz later by flipping
# MERIDIAN_MEMORY_PROVIDER and filling in NEON_DATABASE_URL + VOYAGE_API_KEY.

MERIDIAN_AGENT=${slug}
CORTEX_AGENT_ID=${slug}
MERIDIAN_MEMORY_PROVIDER=embedded

# ── Model routing ──
# Meridian's default router is ROUTEXOR (BYOK, zero markup). Three steps:
#   1. sign up free at https://routexor.com
#   2. add a provider key (Anthropic, OpenAI, ...) in the ROUTEXOR dashboard.
#      BYOK means your provider key pays for the models; without this step,
#      model calls fail.
#   3. create your ROUTEXOR API key and paste it below
# Prefer to go direct or fully local? A direct provider key, OR a local ollama
# (no key — install https://ollama.com then \`ollama pull qwen2.5\`), also works.
ROUTEXOR_API_KEY=
OLLAMA_BASE_URL=http://127.0.0.1:11434
GROQ_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Gateway
MERIDIAN_GATEWAY_TOKEN=
MERIDIAN_GATEWAY_PORT=18889
`;
}

export function envFileTemplate(slug: string): string {
  return `# Meridian agent env: ${slug}
# Per-agent isolation triad. NEVER share these across agents.

MERIDIAN_AGENT=${slug}
CORTEX_AGENT_ID=${slug}

# CORTEX backend (dedicated Neon project per agent)
NEON_DATABASE_URL=

# Voyage AI embeddings (dedicated key per agent)
VOYAGE_API_KEY=

# ── Model routing (at least one required) ──
# Default router: ROUTEXOR (BYOK, zero markup). 1) sign up free at
# https://routexor.com  2) add a provider key (Anthropic, OpenAI, ...) in the
# dashboard: your provider key pays for the models  3) create your ROUTEXOR
# API key and paste it here:
ROUTEXOR_API_KEY=
# Or go direct / local instead of (or alongside) ROUTEXOR:
GROQ_API_KEY=          # free tier, fastest inference — https://console.groq.com
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OLLAMA_BASE_URL=http://127.0.0.1:11434

# VAPI voice channel (optional, set to enable voice)
VAPI_API_KEY=
VAPI_PHONE_NUMBER_ID=
VAPI_ASSISTANT_ID=
# REQUIRED to accept voice webhooks: /vapi/webhook fails closed without it
# (it writes call transcripts to memory, so it must be authenticated). Set the
# same value here and as the assistant's server secret in the VAPI dashboard.
VAPI_WEBHOOK_SECRET=

# Telegram (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_DEFAULT_CHAT_ID=

# Gateway
MERIDIAN_GATEWAY_TOKEN=
MERIDIAN_GATEWAY_PORT=18889
`;
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) out[key] = value;
  }
  return out;
}
