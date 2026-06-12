/**
 * Environment readiness probe: is Ollama running, which models are pulled,
 * which provider keys exist? Produces the ModelPlan the bridge writes into
 * the agent's config so a freshly built agent can actually answer — the
 * runtime's default model chain assumes keys/models this machine may not have.
 *
 * Only booleans about keys ever leave the server; never values.
 */

import type { ModelPlan, SystemStatus } from './types';

interface OllamaTag {
  name: string;
  details?: { parameter_size?: string; family?: string };
}

async function probeOllama(baseUrl: string): Promise<OllamaTag[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: OllamaTag[] };
    return json.models ?? [];
  } catch {
    return null;
  }
}

function paramSize(tag: OllamaTag): number {
  const raw = tag.details?.parameter_size ?? '';
  const m = raw.match(/([\d.]+)\s*([bm])/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === 'b' ? n : n / 1000;
}

/** Chat-capable preference: family order, then bigger params first. */
function rankModels(tags: OllamaTag[]): OllamaTag[] {
  const FAMILY_ORDER = ['qwen2.5', 'qwen3', 'llama3', 'hermes3', 'mistral', 'gemma', 'phi'];
  const familyRank = (name: string): number => {
    const i = FAMILY_ORDER.findIndex((f) => name.startsWith(f));
    return i === -1 ? FAMILY_ORDER.length : i;
  };
  return tags
    .filter((t) => !/embed|bge|minilm/i.test(t.name))
    .sort((a, b) => familyRank(a.name) - familyRank(b.name) || paramSize(b) - paramSize(a));
}

const KEY_DEFAULTS: Record<string, { primary: string; cheap: string; label: string }> = {
  anthropic: {
    primary: 'anthropic/claude-haiku-4-5',
    cheap: 'anthropic/claude-haiku-4-5',
    label: 'Anthropic (Claude Haiku 4.5)',
  },
  openai: {
    primary: 'openai/gpt-4o-mini',
    cheap: 'openai/gpt-4o-mini',
    label: 'OpenAI (GPT-4o mini)',
  },
  groq: {
    primary: 'groq/llama-3.3-70b-versatile',
    cheap: 'groq/llama-3.1-8b-instant',
    label: 'Groq (Llama 3.3 70B)',
  },
  openrouter: {
    primary: 'openrouter/anthropic/claude-haiku-4.5',
    cheap: 'openrouter/anthropic/claude-haiku-4.5',
    label: 'OpenRouter (Claude Haiku 4.5)',
  },
};

export function planFromKeyProvider(provider: keyof typeof KEY_DEFAULTS, pasted: boolean): ModelPlan {
  const d = KEY_DEFAULTS[provider];
  return {
    primary: d.primary,
    fallbacks: [],
    cheapModel: d.cheap,
    label: d.label,
    source: pasted ? 'pasted-key' : 'env-key',
  };
}

export async function systemStatus(): Promise<SystemStatus> {
  const ollamaUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const tags = await probeOllama(ollamaUrl);
  const ranked = tags ? rankModels(tags) : [];

  const keys = {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
  };

  let plan: ModelPlan | null = null;
  if (ranked.length > 0) {
    const [best, ...rest] = ranked;
    // Cheap/smart-routing model: smallest of the ranked set, so short turns
    // stay snappy on local hardware.
    const cheapest = [...ranked].sort((a, b) => paramSize(a) - paramSize(b))[0];
    plan = {
      primary: `ollama/${best.name}`,
      fallbacks: rest.slice(0, 2).map((t) => `ollama/${t.name}`),
      cheapModel: `ollama/${cheapest.name}`,
      label: `Local Ollama (${best.name}) — private, no keys`,
      source: 'ollama',
    };
  } else {
    const envProvider = (['anthropic', 'groq', 'openai', 'openrouter'] as const).find((p) => keys[p]);
    if (envProvider) plan = planFromKeyProvider(envProvider, false);
  }

  return {
    ollama: { running: tags !== null, models: ranked.map((t) => t.name) },
    keys,
    plan,
  };
}
