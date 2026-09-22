/**
 * Model pricing for spend accounting (WS4).
 *
 * Prices come from the ROUTEXOR catalog (`/v1/models`, per 1M tokens, USD),
 * cached once at boot. When a model is not in the catalog the ledger records
 * tokens with `usd: null`; it never guesses a price.
 */
export interface ModelPrice {
  /** USD per 1M prompt tokens. */
  input: number;
  /** USD per 1M completion tokens. */
  output: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export class PricingCatalog {
  private readonly prices = new Map<string, ModelPrice>();
  readonly loadedAt: string | null;

  constructor(entries: Record<string, ModelPrice> = {}, loadedAt: string | null = null) {
    for (const [id, p] of Object.entries(entries)) this.prices.set(normalize(id), p);
    this.loadedAt = loadedAt;
  }

  get size(): number {
    return this.prices.size;
  }

  has(modelRef: string): boolean {
    return this.prices.has(normalize(modelRef));
  }

  /** USD for the usage, or null when the model is unpriced. Never a guess. */
  price(modelRef: string, usage: Usage | undefined): number | null {
    if (!usage) return null;
    const p = this.prices.get(normalize(modelRef));
    if (!p) return null;
    const usd =
      (usage.promptTokens / 1_000_000) * p.input + (usage.completionTokens / 1_000_000) * p.output;
    return Math.round(usd * 1_000_000) / 1_000_000;
  }

  static async fromRoutexor(
    opts: { baseUrl?: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ): Promise<PricingCatalog> {
    const base = (opts.baseUrl ?? 'https://api.routexor.com/v1').replace(/\/$/, '');
    const f = opts.fetchImpl ?? fetch;
    const res = await f(`${base}/models`, {
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`pricing catalog fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: Array<{ id: string; pricing?: { input?: number; output?: number; unit?: string } }>;
    };
    const entries: Record<string, ModelPrice> = {};
    for (const m of body.data ?? []) {
      const p = m.pricing;
      if (!p || typeof p.input !== 'number' || typeof p.output !== 'number') continue;
      if (p.unit && p.unit !== 'per_1M_tokens') continue;
      entries[m.id] = { input: p.input, output: p.output };
    }
    return new PricingCatalog(entries, new Date().toISOString());
  }
}

/** `routexor/claude-haiku-4.5` and `routexor/routexor/claude-haiku-4.5` are one model. */
function normalize(ref: string): string {
  const parts = ref.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'routexor' && parts[1] === 'routexor') parts.shift();
  if (parts.length === 1) return `routexor/${parts[0]}`;
  return parts.join('/');
}
