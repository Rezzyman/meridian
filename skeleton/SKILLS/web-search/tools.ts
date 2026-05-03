/**
 * Web search skill — real-time web access via Tavily.
 *
 * Two tools:
 *   web_search — returns N ranked results with title/url/snippet
 *   web_answer — Tavily synthesizes an answer with cited sources
 *
 * No external libraries. Uses the agent's runtime fetch (Node 20+).
 *
 * Vault keys:
 *   skill.web-search.tavily_api_key   — the operator's Tavily key
 *
 * Rate limits + errors return clean structured responses, never throw,
 * because the model handles them better as data than as exceptions.
 */

interface SkillToolContext {
  cortex: {
    encode(content: string, opts: {
      source?: string;
      priority?: number;
      sensitivity?: 'public' | 'internal' | 'sacred';
    }): Promise<{ memoryId?: number } & Record<string, unknown>>;
  };
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    setMany(entries: Record<string, unknown>): void;
    has(key: string): boolean;
  };
  env: Record<string, string | undefined>;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  requirePassphrase: (skillName: string, candidate?: string) => void;
  tool: (def: unknown) => unknown;
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown; default: (v: string) => unknown };
    number: () => { default: (n: number) => { describe: (s: string) => unknown } };
    boolean: () => { default: (v: boolean) => { describe: (s: string) => unknown } };
  };
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  response_time?: number;
}

function getApiKey(ctx: SkillToolContext): string {
  const key = ctx.vault.get<string>('skill.web-search.tavily_api_key');
  if (!key) {
    throw new Error(
      'web-search skill not configured. run `meridian skills setup web-search` to set your Tavily API key.',
    );
  }
  return key;
}

async function tavilySearch(
  apiKey: string,
  query: string,
  opts: {
    maxResults?: number;
    includeAnswer?: boolean;
    searchDepth?: 'basic' | 'advanced';
    topic?: 'general' | 'news';
    days?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): Promise<TavilyResponse> {
  const body: Record<string, unknown> = {
    query,
    api_key: apiKey,
    max_results: Math.min(Math.max(opts.maxResults ?? 5, 1), 20),
    search_depth: opts.searchDepth ?? 'basic',
    include_answer: opts.includeAnswer ?? false,
    topic: opts.topic ?? 'general',
  };
  if (opts.topic === 'news' && opts.days) body.days = Math.min(Math.max(opts.days, 1), 365);
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TavilyResponse;
}

interface SetupCtx {
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    has(key: string): boolean;
  };
  prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  err: (msg: string) => void;
}

const VAULT_KEY = 'skill.web-search.tavily_api_key';

/**
 * Interactive setup walkthrough. Prompts for the Tavily API key, validates
 * it with a real (no-cost) search call, and stores it in the agent vault.
 */
export async function setup(ctx: SetupCtx): Promise<void> {
  const existing = ctx.vault.get<string>(VAULT_KEY);
  if (existing) {
    const replace = await ctx.prompt('A Tavily API key is already stored. Replace it? [y/N]:');
    if (!/^y(es)?$/i.test(replace)) {
      ctx.log('keeping existing key. nothing changed.');
      return;
    }
  }

  ctx.log('Get a key (free tier, 1k searches/month) at https://tavily.com');
  const key = await ctx.prompt('Paste your Tavily API key:', { mask: true });
  if (!key) {
    ctx.err('no key entered. aborting.');
    return;
  }
  if (!key.startsWith('tvly-')) {
    ctx.warn('key does not start with "tvly-" — that is unusual but proceeding.');
  }

  ctx.log('validating with Tavily...');
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: 'meridian setup ping', max_results: 1 }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      ctx.err(`Tavily rejected the key (${res.status}). ${body.slice(0, 160)}`);
      return;
    }
    const json = (await res.json()) as { results?: unknown[] };
    ctx.log(`key works. test query returned ${(json.results ?? []).length} result(s).`);
  } catch (err) {
    ctx.err(`network error during validation: ${(err as Error).message}`);
    return;
  }

  ctx.vault.set(VAULT_KEY, key);
  ctx.log(`stored under ${VAULT_KEY}.`);
}

export function createTools(ctx: SkillToolContext): Record<string, unknown> {
  const { tool, z } = ctx;
  const Z = z as unknown as {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown; default: (v: string) => unknown };
    number: () => { default: (n: number) => { describe: (s: string) => unknown } };
    boolean: () => { default: (v: boolean) => { describe: (s: string) => unknown } };
  };

  return {
    web_search: tool({
      description:
        'Search the live web and return ranked results. Use when the operator wants ' +
        "current information not in my memory. Pass `topic: 'news'` plus `days: N` to " +
        'restrict to recent news.',
      parameters: Z.object({
        query: Z.string().describe('Search query'),
        maxResults: Z.number().default(5).describe('Number of results (1-20)'),
        topic: Z.string().optional().describe('"general" (default) or "news"'),
        days: Z.number().default(0).describe('Recency window in days (only used when topic=news)'),
        includeDomains: Z.string().optional().describe('Comma-separated domain whitelist (e.g. "reuters.com,apnews.com")'),
        excludeDomains: Z.string().optional().describe('Comma-separated domain blacklist'),
      }),
      execute: async (args: {
        query: string; maxResults: number; topic?: string;
        days: number; includeDomains?: string; excludeDomains?: string;
      }) => {
        try {
          const apiKey = getApiKey(ctx);
          const result = await tavilySearch(apiKey, args.query, {
            maxResults: args.maxResults,
            includeAnswer: false,
            topic: (args.topic === 'news' ? 'news' : 'general') as 'general' | 'news',
            days: args.days > 0 ? args.days : undefined,
            includeDomains: args.includeDomains?.split(',').map((s) => s.trim()).filter(Boolean),
            excludeDomains: args.excludeDomains?.split(',').map((s) => s.trim()).filter(Boolean),
          });
          return {
            query: result.query,
            count: result.results.length,
            results: result.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.content.slice(0, 500),
              score: r.score,
              publishedDate: r.published_date,
            })),
          };
        } catch (err) {
          return { error: (err as Error).message, query: args.query };
        }
      },
    }),

    web_answer: tool({
      description:
        'Ask a question and get a synthesized answer with cited sources. ' +
        'Use for factual questions where the operator wants a direct answer, not a list of links. ' +
        'Always relay the citations back to the operator.',
      parameters: Z.object({
        question: Z.string().describe('The question to answer'),
        searchDepth: Z.string().optional().describe('"basic" (fast, default) or "advanced" (slower, more thorough)'),
        topic: Z.string().optional().describe('"general" (default) or "news"'),
        days: Z.number().default(0).describe('Recency window in days (only used when topic=news)'),
      }),
      execute: async (args: {
        question: string; searchDepth?: string; topic?: string; days: number;
      }) => {
        try {
          const apiKey = getApiKey(ctx);
          const result = await tavilySearch(apiKey, args.question, {
            maxResults: 5,
            includeAnswer: true,
            searchDepth: (args.searchDepth === 'advanced' ? 'advanced' : 'basic') as 'basic' | 'advanced',
            topic: (args.topic === 'news' ? 'news' : 'general') as 'general' | 'news',
            days: args.days > 0 ? args.days : undefined,
          });
          return {
            question: result.query,
            answer: result.answer ?? '(Tavily returned no synthesized answer)',
            sources: result.results.map((r) => ({
              title: r.title,
              url: r.url,
              publishedDate: r.published_date,
            })),
          };
        } catch (err) {
          return { error: (err as Error).message, question: args.question };
        }
      },
    }),
  };
}
