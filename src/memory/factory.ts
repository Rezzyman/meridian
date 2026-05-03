/**
 * createMemoryProvider — boot-time selector for Meridian's memory layer.
 *
 *   MERIDIAN_MEMORY_PROVIDER=cortex (default) → CortexMemoryProvider, the
 *     open-source path. Talks HTTP to a co-located CORTEX server.
 *
 *   MERIDIAN_MEMORY_PROVIDER=quartz → lazy-imports @aterna/quartz and
 *     wraps a CortexBind + Quartz pipeline as a QuartzMemoryProvider.
 *     If the package is missing or fails to load, the factory logs a
 *     warning and falls back to CortexMemoryProvider so the agent boots.
 */
import { CortexBind, bindCortex } from '../cortex/bind.js';
import type { AgentEnv } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import { CortexBackendAdapter } from './cortex-backend-adapter.js';
import type { MemoryProvider } from './provider.js';
import { QuartzMemoryProvider, type QuartzLib } from './quartz-memory-provider.js';

export interface CreateMemoryProviderOptions {
  env: AgentEnv;
  /** Required when MERIDIAN_MEMORY_PROVIDER=quartz; ignored otherwise. */
  router?: ProviderRouter;
  /** Optional override for CORTEX base URL; falls back to env.MERIDIAN_CORTEX_URL. */
  cortexBaseUrl?: string;
  /** Reuse an existing CortexBind instead of constructing a new one; preferred during boot. */
  cortex?: CortexBind;
  /** Logger callback for boot-panel observability; defaults to console.warn for fallback notices. */
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export interface CreateMemoryProviderResult {
  provider: MemoryProvider;
  /** Which provider actually ended up active after fallback handling. */
  selected: 'cortex' | 'quartz';
  /** Set when a Quartz selection fell back to CORTEX; useful for the boot panel. */
  fallbackReason?: string;
}

export async function createMemoryProvider(
  opts: CreateMemoryProviderOptions,
): Promise<CreateMemoryProviderResult> {
  const log = opts.log ?? defaultLog;
  const baseUrl = opts.cortexBaseUrl ?? opts.env.MERIDIAN_CORTEX_URL;
  const cortex = opts.cortex ?? bindCortex(opts.env.CORTEX_AGENT_ID, baseUrl);

  if (opts.env.MERIDIAN_MEMORY_PROVIDER === 'cortex') {
    log('info', 'memory provider: cortex (open-source default)');
    return { provider: cortex, selected: 'cortex' };
  }

  if (!opts.router) {
    const reason = 'MERIDIAN_MEMORY_PROVIDER=quartz requires a ProviderRouter; falling back to cortex';
    log('warn', reason);
    return { provider: cortex, selected: 'cortex', fallbackReason: reason };
  }

  try {
    const lib = await loadQuartzPipeline({
      env: opts.env,
      router: opts.router,
      cortex,
    });
    log('info', 'memory provider: quartz (proprietary; @aterna/quartz)');
    return {
      provider: new QuartzMemoryProvider({ cortex, lib }),
      selected: 'quartz',
    };
  } catch (err) {
    const reason = `quartz unavailable (${(err as Error).message}); falling back to cortex`;
    log('warn', reason);
    return { provider: cortex, selected: 'cortex', fallbackReason: reason };
  }
}

interface LoadQuartzInput {
  env: AgentEnv;
  router: ProviderRouter;
  cortex: ReturnType<typeof bindCortex>;
}

/**
 * Lazy-imports @aterna/quartz and constructs the pipeline. The cast at the
 * return boundary is the trust line: from here on the pipeline is treated as
 * conformant to QuartzPipeline (the structural shape declared in
 * quartz-memory-provider.ts). Mismatches blow up at first call, not at boot.
 */
async function loadQuartzPipeline(input: LoadQuartzInput): Promise<QuartzLib> {
  const mod = (await import('@aterna/quartz')) as {
    QuartzMemoryProvider?: new (
      backend: unknown,
      opts?: Record<string, unknown>,
    ) => unknown;
  };

  if (!mod.QuartzMemoryProvider) {
    throw new Error('@aterna/quartz did not export QuartzMemoryProvider');
  }

  const backend = new CortexBackendAdapter({
    cortex: input.cortex,
    router: input.router,
    voyageApiKey: input.env.VOYAGE_API_KEY,
  });

  const pipeline = new mod.QuartzMemoryProvider(backend, {});
  return { pipeline: pipeline as QuartzLib['pipeline'] };
}

function defaultLog(level: 'info' | 'warn', msg: string): void {
  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(`[meridian/memory] ${msg}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[meridian/memory] ${msg}`);
  }
}
