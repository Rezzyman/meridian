/**
 * Wearables skill — pull ambient lifelog transcripts from a wearable
 * lifelog provider and encode each into the agent's CORTEX. Provider
 * abstraction: this skill is the category, not the vendor. Each provider
 * has its own adapter that knows how to fetch lifelogs from its API.
 *
 * Working providers (v1):
 *   - limitless    (Limitless Pendant — api.limitless.ai)
 *   - bee          (Bee Pendant — local proxy at bee.computer)
 *
 * Pending providers (registered with honest status; no public/usable API
 * available yet — operator gets a clear message instead of a stub call):
 *   - plaud        (Plaud Developer Platform — private beta, waitlist
 *                   only as of 2026-05; no public API for third parties)
 *
 * Dropped from the registry (no API exists for third-party lifelog access):
 *   - friend       (transcripts are phone-local on the open-source app;
 *                   no cloud/server API to call)
 *   - meta-rayban  (Wearables Device Access Toolkit is partner-only and
 *                   for live sensor access, not stored transcripts)
 *
 * Adding a new provider: implement the WearableProvider interface,
 * register it in PROVIDERS below. The setup walkthrough, vault layout,
 * and pull tool all flow through automatically.
 *
 * Vault keys this skill reads/writes:
 *   skill.wearables.passphrase_hash      — sha256 of operator passphrase
 *   skill.wearables.configured_providers — string[] of provider ids the operator has set up
 *   skill.wearables.ingested_ids         — string[] of lifelog IDs already encoded (cross-provider)
 *   skill.wearables.last_sync_at         — ISO timestamp of most recent successful pull
 *   skill.wearables.<provider>.api_key   — per-provider API key (when applicable)
 *
 * Memory source tag: `wearables:<provider>:<date>:<lifelog_id>` so recall
 * can cite which device captured which transcript. Existing memories
 * tagged `limitless:<date>:<id>` continue to work — no rewrite of CORTEX.
 *
 * NOTE: this file does not import `ai` or `zod` directly. Skills receive
 * those factories from the runtime context.
 */

interface SkillToolContext {
  cortex: {
    encode(
      content: string,
      opts: {
        source?: string;
        priority?: number;
        sensitivity?: 'public' | 'internal' | 'sacred';
      },
    ): Promise<{ memoryId?: number } & Record<string, unknown>>;
  };
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    setMany(entries: Record<string, unknown>): void;
    has(key: string): boolean;
  };
  env: Record<string, string | undefined>;
  logger: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
  requirePassphrase: (skillName: string, candidate?: string) => void;
  tool: (def: unknown) => unknown;
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown };
    number: () => {
      int: () => { min: (n: number) => { max: (n: number) => { default: (n: number) => { describe: (s: string) => unknown } } } };
    };
  };
}

// ─── Provider abstraction ──────────────────────────────────────────────

/** Normalized lifelog shape every provider's adapter returns. */
interface NormalizedLifelog {
  /** Stable id. Provider may prefix with provider-id to avoid collisions. */
  id: string;
  /** Free-form transcript body. Stored as one CORTEX memory per lifelog. */
  body: string;
  /** ISO date the lifelog was captured (for source tagging). */
  capturedDate: string;
}

/** Result of a one-day fetch from a provider. */
interface ProviderFetchResult {
  lifelogs: NormalizedLifelog[];
  /** Continuation cursor; provider returns one if there are more pages for this day. */
  nextCursor?: string;
}

/** Credentials handed to a provider adapter at fetch time. */
interface ProviderCredentials {
  apiKey?: string;
  // future: oauth tokens, account ids, etc.
}

/** A wearable lifelog provider adapter. */
interface WearableProvider {
  /** Stable id (e.g. 'limitless'). Used in vault keys, source tags, setup. */
  id: string;
  /** Human-readable name for setup walkthroughs. */
  displayName: string;
  /** Vendor URL for the operator to find their dev/API settings. */
  developerUrl: string;
  /** How the operator hands creds to the skill. */
  authType: 'env-api-key' | 'vault-api-key' | 'oauth';
  /** Env var name when authType=env-api-key (read by skill loader prescan). */
  envKey?: string;
  /** Vault key stem when authType=vault-api-key (skill.wearables.<id>.api_key). */
  vaultKey?: string;
  /** True when this provider has a working adapter; false for stubs. */
  implemented: boolean;
  /** Read credentials from env / vault. */
  resolveCredentials(ctx: SkillToolContext): ProviderCredentials | undefined;
  /** Validate the credentials against the provider's API. Returns ok or an error message. */
  ping(creds: ProviderCredentials): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Fetch one day of lifelogs. Throws on hard error. */
  fetchByDate(opts: { date: string; cursor?: string; creds: ProviderCredentials }): Promise<ProviderFetchResult>;
}

// ─── Limitless (working) ───────────────────────────────────────────────

interface LimitlessRawLifelog {
  id: string;
  title?: string;
  markdown?: string;
  startTime?: string;
  endTime?: string;
}
interface LimitlessApiResponse {
  data?: { lifelogs?: LimitlessRawLifelog[] };
  meta?: { lifelogs?: { nextCursor?: string } };
}

const limitlessProvider: WearableProvider = {
  id: 'limitless',
  displayName: 'Limitless Pendant',
  developerUrl: 'https://app.limitless.ai/settings/developer',
  authType: 'env-api-key',
  envKey: 'LIMITLESS_API_KEY',
  implemented: true,

  resolveCredentials(ctx) {
    const apiKey = ctx.env.LIMITLESS_API_KEY;
    return apiKey ? { apiKey } : undefined;
  },

  async ping(creds) {
    if (!creds.apiKey) return { ok: false, error: 'no api key' };
    try {
      const url = new URL('https://api.limitless.ai/v1/lifelogs');
      const today = new Date().toISOString().slice(0, 10);
      url.searchParams.set('date', today);
      url.searchParams.set('timezone', 'UTC');
      url.searchParams.set('limit', '1');
      const res = await fetch(url, { headers: { 'X-API-Key': creds.apiKey, Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) return { ok: false, error: `auth rejected (${res.status})` };
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetchByDate({ date, cursor, creds }) {
    if (!creds.apiKey) throw new Error('no LIMITLESS_API_KEY');
    const url = new URL('https://api.limitless.ai/v1/lifelogs');
    url.searchParams.set('date', date);
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('includeMarkdown', 'true');
    url.searchParams.set('limit', '10');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString(), { headers: { 'X-API-Key': creds.apiKey } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Limitless API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as LimitlessApiResponse;
    const raw = json.data?.lifelogs ?? [];
    const lifelogs: NormalizedLifelog[] = raw
      .filter((lg): lg is LimitlessRawLifelog & { id: string } => !!lg.id)
      .map((lg) => ({
        id: `limitless:${lg.id}`,
        body: (lg.markdown ?? '').trim(),
        capturedDate: date,
      }))
      .filter((lg) => lg.body.length > 0);
    return { lifelogs, nextCursor: json.meta?.lifelogs?.nextCursor };
  },
};

// ─── Bee (working via local bee proxy) ─────────────────────────────────
//
// Bee's developer surface is `bee proxy` — a local HTTP server the
// operator runs on the same box as Meridian. Default port: 8787.
// Auth is a Bearer token (`bee login` prints/stores it; operator copies
// to BEE_TOKEN env). Endpoints documented at docs.bee.computer/docs/proxy.
//
// The conversations list endpoint does not accept date filters today,
// so we fetch pages and filter client-side by capturedDate. For "last N
// days" pulls this is fine; for very deep historical backfills it's
// O(total conversations / page_size) requests. Acceptable for v1.
//
// Field mapping is best-effort against Bee's documented response shape;
// if Bee's API evolves, adjust the normalize() function below.

interface BeeRawConversation {
  id?: string;
  conversationId?: string;
  text?: string;
  summary?: string;
  transcript?: string;
  createdAt?: string;
  startedAt?: string;
  date?: string;
}
interface BeeListResponse {
  conversations?: BeeRawConversation[];
  data?: BeeRawConversation[];
  cursor?: string;
  nextCursor?: string;
}

const beeProvider: WearableProvider = {
  id: 'bee',
  displayName: 'Bee Pendant',
  developerUrl: 'https://docs.bee.computer/docs/proxy',
  authType: 'env-api-key',
  envKey: 'BEE_TOKEN',
  implemented: true,

  resolveCredentials(ctx) {
    const apiKey = ctx.env.BEE_TOKEN;
    return apiKey ? { apiKey } : undefined;
  },

  async ping(creds) {
    if (!creds.apiKey) return { ok: false, error: 'no BEE_TOKEN' };
    const baseUrl = process.env.BEE_API_URL ?? 'http://127.0.0.1:8787';
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v1/conversations?limit=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: `auth rejected (${res.status})` };
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      // The most common failure is "is bee proxy running?"
      const hint = msg.includes('ECONNREFUSED')
        ? 'bee proxy not reachable. Run `bee proxy` on this host first.'
        : msg;
      return { ok: false, error: hint };
    }
  },

  async fetchByDate({ date, cursor, creds }) {
    if (!creds.apiKey) throw new Error('no BEE_TOKEN');
    const baseUrl = process.env.BEE_API_URL ?? 'http://127.0.0.1:8787';
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/v1/conversations`);
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bee proxy ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as BeeListResponse;
    const raw = json.conversations ?? json.data ?? [];

    // Normalize and client-side filter by capturedDate. Conversation timestamp
    // can be at any of several keys depending on Bee version — try them in order.
    const targetDate = date; // YYYY-MM-DD
    const lifelogs: NormalizedLifelog[] = [];
    for (const c of raw) {
      const id = c.id ?? c.conversationId;
      if (!id) continue;
      const tsRaw = c.createdAt ?? c.startedAt ?? c.date;
      const capturedDate = tsRaw ? tsRaw.slice(0, 10) : '';
      if (!capturedDate || capturedDate !== targetDate) continue;
      const body = (c.transcript ?? c.text ?? c.summary ?? '').trim();
      if (!body) continue;
      lifelogs.push({ id: `bee:${id}`, body, capturedDate });
    }
    return { lifelogs, nextCursor: json.nextCursor ?? json.cursor };
  },
};

// ─── Plaud (honest waitlist stub) ──────────────────────────────────────
//
// Plaud Developer Platform is in private beta as of 2026-05. There is no
// public API a third-party Meridian agent can call. Operator gets a
// clear "waitlist" message and a pointer at the right URL. When Plaud
// opens the API, this stub is replaced with a real adapter.

const plaudProvider: WearableProvider = {
  id: 'plaud',
  displayName: 'Plaud Note',
  developerUrl: 'https://www.plaud.ai/pages/developer-platform',
  authType: 'env-api-key',
  envKey: 'PLAUD_API_KEY',
  implemented: false,

  resolveCredentials(ctx) {
    const apiKey = ctx.env.PLAUD_API_KEY;
    return apiKey ? { apiKey } : undefined;
  },

  async ping() {
    return {
      ok: false,
      error:
        'Plaud Developer Platform is in private beta (waitlist only as of 2026-05). Sign up at https://www.plaud.ai/pages/developer-platform — once the public API ships, this adapter lands.',
    };
  },

  async fetchByDate() {
    throw new Error(
      'Plaud Developer Platform is in private beta (no public API yet). Waitlist: https://www.plaud.ai/pages/developer-platform',
    );
  },
};

/** Provider registry. Order is the order the setup walkthrough lists them. */
const PROVIDERS: ReadonlyArray<WearableProvider> = [
  limitlessProvider,
  beeProvider,
  plaudProvider,
];

function getProvider(id: string): WearableProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ─── Setup walkthrough ─────────────────────────────────────────────────

interface SetupCtx {
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    has(key: string): boolean;
  };
  env: Record<string, string | undefined>;
  agentSlug: string;
  prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  err: (msg: string) => void;
}

export async function setup(ctx: SetupCtx): Promise<void> {
  ctx.log('Wearables: pull ambient lifelog transcripts from a wearable into CORTEX.');
  ctx.log('Pick a provider. The current implementation only ships a working adapter for Limitless;');
  ctx.log('others are listed so you can see the roadmap and choose to set the env key in advance.');
  ctx.log('');

  const configured = new Set<string>(
    ctx.vault.get<string[]>('skill.wearables.configured_providers') ?? [],
  );

  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i]!;
    const flag = p.implemented ? '' : ' (adapter not yet implemented)';
    const isConfigured = configured.has(p.id) ? ' [configured]' : '';
    ctx.log(`  ${i + 1}. ${p.displayName}${flag}${isConfigured}`);
  }
  ctx.log('');
  const choice = (await ctx.prompt('Pick a provider by number, or blank to finish:')).trim();
  if (!choice) {
    ctx.log(`done. configured providers: ${[...configured].join(', ') || '(none)'}`);
    return;
  }
  const idx = parseInt(choice, 10) - 1;
  const provider = PROVIDERS[idx];
  if (!provider) {
    ctx.err(`invalid choice: ${choice}`);
    return;
  }

  ctx.log(`Selected: ${provider.displayName}.`);
  if (!provider.implemented) {
    ctx.warn(`${provider.displayName} does not have a working adapter in this release.`);
    ctx.log(`The architecture is in place; the fetch adapter is the missing piece.`);
    ctx.log(`Track / contribute: https://github.com/Rezzyman/meridian/issues`);
    ctx.log(`You can still set the env key now so it's ready when the adapter ships:`);
    if (provider.envKey) ctx.log(`  ${provider.envKey}=...  (in ~/.meridian/${ctx.agentSlug}/.env)`);
    return;
  }

  // Working provider path.
  ctx.log(`Get a key at: ${provider.developerUrl}`);
  if (provider.authType === 'env-api-key' && provider.envKey) {
    ctx.log(`Set ${provider.envKey} in ~/.meridian/${ctx.agentSlug}/.env, then re-run setup to validate.`);
    const creds = provider.resolveCredentials(ctx as unknown as SkillToolContext);
    if (!creds || !creds.apiKey) {
      ctx.warn(`${provider.envKey} is not set yet. The skill will surface "no api key" if pull is invoked.`);
      return;
    }
    ctx.log('validating with the provider...');
    const ping = await provider.ping(creds);
    if (!ping.ok) {
      ctx.err(`${provider.displayName} rejected the credentials: ${ping.error}`);
      return;
    }
    ctx.log('credentials accepted.');
    configured.add(provider.id);
    ctx.vault.set('skill.wearables.configured_providers', [...configured]);
    ctx.log(`${provider.displayName} is configured. Set passphrase next via the runner's prompt if not already.`);
    return;
  }

  if (provider.authType === 'vault-api-key' && provider.vaultKey) {
    const apiKey = await ctx.prompt(`Paste your ${provider.displayName} API key:`, { mask: true });
    if (!apiKey) {
      ctx.err('no key entered. aborting.');
      return;
    }
    const creds: ProviderCredentials = { apiKey };
    ctx.log('validating with the provider...');
    const ping = await provider.ping(creds);
    if (!ping.ok) {
      ctx.err(`${provider.displayName} rejected the credentials: ${ping.error}`);
      return;
    }
    ctx.vault.set(`skill.wearables.${provider.id}.${provider.vaultKey}`, apiKey);
    configured.add(provider.id);
    ctx.vault.set('skill.wearables.configured_providers', [...configured]);
    ctx.log(`${provider.displayName} is configured.`);
    return;
  }

  if (provider.authType === 'oauth') {
    ctx.warn(`${provider.displayName} uses OAuth. Interactive OAuth setup for this provider is not yet built.`);
    ctx.log(`Track at https://github.com/Rezzyman/meridian/issues`);
    return;
  }
}

// ─── Pull + status tools ───────────────────────────────────────────────

export function createTools(ctx: SkillToolContext): Record<string, unknown> {
  const { tool, z } = ctx;
  return {
    wearables_pull: tool({
      description:
        'Pull recent lifelog transcripts from a wearable provider and encode each into CORTEX. ' +
        'Idempotent (deduped by lifelog id). Provider arg picks which wearable to pull from; ' +
        'defaults to all configured providers. Requires the wearables skill to be authorized — ' +
        'if not, ask the operator to run "/auth wearables <passphrase>".',
      parameters: (z as unknown as { object: (s: Record<string, unknown>) => unknown }).object({
        sinceDays: (z as unknown as { number: () => { int: () => { min: (n: number) => { max: (n: number) => { default: (n: number) => { describe: (s: string) => unknown } } } } } })
          .number()
          .int()
          .min(1)
          .max(60)
          .default(7)
          .describe('Pull lifelogs from the last N days (default 7, max 60)'),
        untilDate: (z as unknown as { string: () => { describe: (s: string) => { optional: () => unknown } } })
          .string()
          .describe('ISO date (YYYY-MM-DD) for the most recent day to include. Default: today.')
          .optional(),
        provider: (z as unknown as { string: () => { describe: (s: string) => { optional: () => unknown } } })
          .string()
          .describe('Provider id (limitless, plaud, bee, friend, meta-rayban). Default: every configured provider.')
          .optional(),
      }),
      execute: async (args: { sinceDays: number; untilDate?: string; provider?: string }) => {
        ctx.requirePassphrase('wearables');
        const { sinceDays, untilDate } = args;
        const until = untilDate ? new Date(untilDate) : new Date();
        if (isNaN(until.getTime())) return { error: `Invalid untilDate: ${untilDate}` };
        const since = new Date(until.getTime() - sinceDays * 24 * 3600 * 1000);

        const configured =
          (ctx.vault.get<string[]>('skill.wearables.configured_providers') ?? []).slice();
        // Back-compat: if the operator set LIMITLESS_API_KEY but never ran setup,
        // treat limitless as implicitly configured so existing setups keep working.
        if (!configured.includes('limitless') && ctx.env.LIMITLESS_API_KEY) configured.push('limitless');

        const targets: WearableProvider[] = args.provider
          ? [getProvider(args.provider)].filter((p): p is WearableProvider => !!p)
          : configured.map((id) => getProvider(id)).filter((p): p is WearableProvider => !!p);

        if (targets.length === 0) {
          return {
            error:
              'no wearable providers configured. run `meridian skills setup wearables` to pick a provider.',
          };
        }

        const ingestedIds = new Set<string>(
          ctx.vault.get<string[]>('skill.wearables.ingested_ids') ?? [],
        );
        const newIds: string[] = [];
        const errors: string[] = [];
        let totalSeen = 0;
        let totalEncoded = 0;
        const perProvider: Record<string, { seen: number; encoded: number; skipped: number; errors: string[] }> = {};

        for (const provider of targets) {
          perProvider[provider.id] = { seen: 0, encoded: 0, skipped: 0, errors: [] };
          if (!provider.implemented) {
            const msg = `${provider.displayName} adapter not yet implemented; skipped`;
            errors.push(msg);
            perProvider[provider.id]!.errors.push(msg);
            continue;
          }
          const creds = provider.resolveCredentials(ctx);
          if (!creds) {
            const msg = `${provider.displayName}: credentials not configured`;
            errors.push(msg);
            perProvider[provider.id]!.errors.push(msg);
            continue;
          }
          for (let d = new Date(since); d <= until; d.setDate(d.getDate() + 1)) {
            const dayIso = d.toISOString().slice(0, 10);
            let cursor: string | undefined = undefined;
            for (let page = 0; page < 20; page++) {
              let result: ProviderFetchResult;
              try {
                result = await provider.fetchByDate({ date: dayIso, cursor, creds });
              } catch (err) {
                const msg = `${provider.id} ${dayIso}: ${(err as Error).message}`;
                errors.push(msg);
                perProvider[provider.id]!.errors.push(msg);
                break;
              }
              perProvider[provider.id]!.seen += result.lifelogs.length;
              totalSeen += result.lifelogs.length;
              for (const lg of result.lifelogs) {
                if (ingestedIds.has(lg.id)) {
                  perProvider[provider.id]!.skipped++;
                  continue;
                }
                try {
                  await ctx.cortex.encode(lg.body, {
                    source: `wearables:${provider.id}:${lg.capturedDate}:${lg.id}`,
                    priority: 2,
                    sensitivity: 'internal',
                  });
                  ingestedIds.add(lg.id);
                  newIds.push(lg.id);
                  perProvider[provider.id]!.encoded++;
                  totalEncoded++;
                } catch (err) {
                  const msg = `${provider.id} encode ${lg.id}: ${(err as Error).message}`;
                  errors.push(msg);
                  perProvider[provider.id]!.errors.push(msg);
                }
              }
              cursor = result.nextCursor;
              if (!cursor) break;
            }
          }
        }

        ctx.vault.setMany({
          'skill.wearables.ingested_ids': [...ingestedIds].slice(-50000),
          'skill.wearables.last_sync_at': new Date().toISOString(),
        });

        return {
          dateRange: { from: since.toISOString().slice(0, 10), to: until.toISOString().slice(0, 10) },
          providers: targets.map((p) => p.id),
          seen: totalSeen,
          encoded: totalEncoded,
          newLifelogIds: newIds.slice(0, 20),
          totalIngestedEver: ingestedIds.size,
          perProvider,
          errors: errors.slice(0, 10),
        };
      },
    }),

    wearables_status: tool({
      description:
        'Show wearables sync state — configured providers, last sync time, total lifelogs ingested. ' +
        'No API call, no passphrase needed.',
      parameters: (z as unknown as { object: (s: Record<string, unknown>) => unknown }).object({}),
      execute: async () => {
        const lastSync = ctx.vault.get<string>('skill.wearables.last_sync_at');
        const ingested = ctx.vault.get<string[]>('skill.wearables.ingested_ids') ?? [];
        const configured = ctx.vault.get<string[]>('skill.wearables.configured_providers') ?? [];
        // back-compat shim
        const effectiveConfigured = configured.length === 0 && ctx.env.LIMITLESS_API_KEY
          ? ['limitless']
          : configured;
        return {
          providers: PROVIDERS.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            implemented: p.implemented,
            configured: effectiveConfigured.includes(p.id),
          })),
          configuredProviders: effectiveConfigured,
          passphraseSet: ctx.vault.has('skill.wearables.passphrase_hash'),
          lastSyncAt: lastSync ?? null,
          totalIngestedEver: ingested.length,
        };
      },
    }),
  };
}
