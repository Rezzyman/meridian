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

# Model provider — local ollama needs no key (install: https://ollama.com,
# then \`ollama pull qwen2.5\`). Or paste a key for any provider below.
OLLAMA_BASE_URL=http://127.0.0.1:11434
GROQ_API_KEY=
ROUTEXOR_API_KEY=
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

# Model providers (at least one required)
# Groq: free tier, fastest inference. Get a key at https://console.groq.com
GROQ_API_KEY=
ROUTEXOR_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OLLAMA_BASE_URL=http://127.0.0.1:11434

# VAPI voice channel (optional, set to enable voice)
VAPI_API_KEY=
VAPI_PHONE_NUMBER_ID=
VAPI_ASSISTANT_ID=
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
