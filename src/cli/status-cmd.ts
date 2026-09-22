import { activeAgentSlug, ensureAgentHome } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { colors } from '../utils/truecolor.js';

/**
 * `meridian status` (WS5): the running gateway's /health, rendered for a
 * human. Same facts the fleet health check reads; no second source of truth.
 */
export async function runStatus(opts: { json?: boolean; port?: number } = {}): Promise<number> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  let port = opts.port ?? 18889;
  try {
    const env = loadAgentEnv(home);
    port = opts.port ?? env.MERIDIAN_GATEWAY_PORT ?? port;
  } catch {
    /* env may be incomplete on a fresh agent; the default port still works */
  }
  const url = `http://127.0.0.1:${port}/health`;
  let body: Record<string, unknown>;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(colors.err(`gateway not reachable at ${url}: ${(err as Error).message}`));
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return body.ok ? 0 : 1;
  }
  const line = (k: string, v: unknown) =>
    console.log(`  ${colors.steel(k.padEnd(22, ' '))}${String(v)}`);
  console.log(
    colors.cyan(
      `Meridian ${String(body.version ?? '')} · agent ${String(body.agent)} · ${body.ok ? colors.ok('ok') : colors.err('NOT OK')}`,
    ),
  );
  line('uptime', `${body.uptimeSec ?? '?'}s since ${body.startedAt ?? '?'}`);
  const provider = body.provider as {
    primary?: string;
    baseUrlHost?: string;
    ok?: boolean;
    reason?: string;
  } | null;
  line(
    'provider',
    provider
      ? `${provider.primary} via ${provider.baseUrlHost ?? '?'} ${provider.ok ? '' : `FAIL: ${provider.reason}`}`
      : 'n/a',
  );
  const cortex = body.cortex as { status?: string; checkedAt?: string | null } | undefined;
  line('cortex', `${cortex?.status ?? 'unknown'} (checked ${cortex?.checkedAt ?? 'never'})`);
  const inf = body.lastHourInference as { turns?: number; errors?: number } | null;
  line('last hour', inf ? `${inf.turns} turns, ${inf.errors} errors` : 'n/a');
  const spend = body.spend as {
    today?: { usd: number; calls: number };
    month?: { usd: number };
  } | null;
  line(
    'spend',
    spend
      ? `today $${spend.today?.usd.toFixed(4)} (${spend.today?.calls} calls), month $${spend.month?.usd.toFixed(2)}`
      : 'n/a',
  );
  const breaker = body.breaker as Array<{ ref: string; state: string }> | undefined;
  line(
    'breaker',
    breaker && breaker.length ? breaker.map((b) => `${b.ref}=${b.state}`).join(', ') : 'all closed',
  );
  line('last delivery', body.lastProactiveDelivery ?? 'never');
  const autos = body.automations as
    | Array<{
        name: string;
        nextFireAt: string | null;
        lastDeliveredAt: string | null;
        delivers: boolean;
        requiresApproval: boolean;
        graduatedAt: string | null;
      }>
    | undefined;
  if (autos && autos.length) {
    console.log(colors.cyan('  automations'));
    for (const a of autos) {
      const gate = a.graduatedAt ? 'graduated' : a.requiresApproval ? 'approval' : 'direct';
      line(
        `    ${a.name}`,
        `${a.delivers ? 'delivers' : 'silent'}/${gate} next ${a.nextFireAt ?? 'n/a'} last ${a.lastDeliveredAt ?? 'never'}`,
      );
    }
  } else {
    line('automations', 'none armed');
  }
  return body.ok ? 0 : 1;
}
