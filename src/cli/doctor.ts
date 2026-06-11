/**
 * `meridian doctor` — end-to-end health check across the AgentOS.
 *
 * Beyond the basic foundation checks (node version, triad isolation, layer
 * presence), runs LIVE smoke tests against the active agent: CORTEX recall
 * with a known-good query, LLM provider dry-run with a tiny prompt, channel
 * arming (Telegram getMe / VAPI assistant fetch), session DB writability,
 * skill manifest parse, operator config sanity, and disk space.
 *
 * Exit code 0 = all green. 1 = at least one fail. Warns are non-blocking.
 */

import { existsSync, writeFileSync, unlinkSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeAgentSlug,
  ensureAgentHome,
  listAgents,
  loadAgentConfig,
  resolveHome,
  SEVEN_LAYERS,
} from '../config/home.js';
import { readEnvFile, loadAgentEnv } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { createMemoryProvider } from '../memory/index.js';
import { ProviderRouter } from '../providers/router.js';
import { streamText } from 'ai';
import { colors } from '../utils/truecolor.js';

interface CheckRow {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail?: string;
}

function row(name: string, status: CheckRow['status'], detail?: string): CheckRow {
  return { name, status, detail };
}

function printRow(r: CheckRow): void {
  const tag =
    r.status === 'ok'
      ? colors.ok('  ok  ')
      : r.status === 'warn'
        ? colors.warn(' warn ')
        : r.status === 'fail'
          ? colors.err(' fail ')
          : colors.muted(' skip ');
  const detail = r.detail ? `  ${colors.muted(r.detail)}` : '';
  console.log(`${tag} ${r.name}${detail}`);
}

export async function runDoctor(): Promise<number> {
  console.log(colors.cyan('Meridian doctor'));
  console.log(colors.muted('Checking foundation...'));
  const rows: CheckRow[] = [];

  // 1. Node version
  const major = parseInt(process.versions.node.split('.')[0]!, 10);
  rows.push(
    row(
      'Node 20+',
      major >= 20 ? 'ok' : 'fail',
      `running ${process.versions.node}`,
    ),
  );

  // 2. Agents discovered (template scaffolds with __ in the name are not
  // real agents — skip them).
  const agents = listAgents().filter((a) => !a.includes('__'));
  if (!agents.length) {
    rows.push(row('Agents discovered', 'warn', 'no agents yet — run `meridian init <name>`'));
    rows.forEach(printRow);
    return rows.some((r) => r.status === 'fail') ? 1 : 0;
  }
  rows.push(row('Agents discovered', 'ok', `${agents.length} agent(s): ${agents.join(', ')}`));

  // 3. Per-agent triad uniqueness across agents
  const seenNeon = new Map<string, string>();
  const seenVoyage = new Map<string, string>();
  const seenOpenRouter = new Map<string, string>();
  const seenGroq = new Map<string, string>();
  const triadIssues: string[] = [];
  for (const slug of agents) {
    const home = resolveHome(slug);
    if (!existsSync(home.envPath)) {
      triadIssues.push(`${slug}: .env missing`);
      continue;
    }
    const env = readEnvFile(home.envPath);
    if (env.NEON_DATABASE_URL) {
      if (seenNeon.has(env.NEON_DATABASE_URL))
        triadIssues.push(`Neon shared between ${seenNeon.get(env.NEON_DATABASE_URL)} and ${slug}`);
      else seenNeon.set(env.NEON_DATABASE_URL, slug);
    }
    if (env.VOYAGE_API_KEY) {
      if (seenVoyage.has(env.VOYAGE_API_KEY))
        triadIssues.push(`Voyage key shared between ${seenVoyage.get(env.VOYAGE_API_KEY)} and ${slug}`);
      else seenVoyage.set(env.VOYAGE_API_KEY, slug);
    }
    if (env.OPENROUTER_API_KEY) {
      if (seenOpenRouter.has(env.OPENROUTER_API_KEY))
        triadIssues.push(
          `OpenRouter key shared between ${seenOpenRouter.get(env.OPENROUTER_API_KEY)} and ${slug}`,
        );
      else seenOpenRouter.set(env.OPENROUTER_API_KEY, slug);
    }
    if (env.GROQ_API_KEY) {
      if (seenGroq.has(env.GROQ_API_KEY))
        triadIssues.push(
          `Groq key shared between ${seenGroq.get(env.GROQ_API_KEY)} and ${slug}`,
        );
      else seenGroq.set(env.GROQ_API_KEY, slug);
    }
  }
  rows.push(
    row(
      'Isolation triad uniqueness',
      triadIssues.length ? 'fail' : 'ok',
      triadIssues.length ? triadIssues.join('; ') : 'each agent has unique Neon + Voyage + OpenRouter',
    ),
  );

  // 4. Per-agent layer presence
  for (const slug of agents) {
    const home = ensureAgentHome(slug);
    for (const layer of SEVEN_LAYERS) {
      const dir = home.layer(layer);
      rows.push(row(`${slug}/${layer}`, existsSync(dir) ? 'ok' : 'warn'));
    }
  }

  // 5. CORTEX reachability — use the ACTIVE agent (env or `meridian use`)
  // not just the first one alphabetically. Falls back to the first real
  // agent if no active is set.
  let activeSlug: string;
  try {
    activeSlug = activeAgentSlug();
    if (!agents.includes(activeSlug)) activeSlug = agents[0]!;
  } catch {
    activeSlug = agents[0]!;
  }
  const home = ensureAgentHome(activeSlug);
  let config: ReturnType<typeof loadAgentConfig>;
  try {
    config = loadAgentConfig(home);
  } catch {
    rows.push(row('Active agent config', 'fail', 'config.yaml invalid'));
    rows.forEach(printRow);
    return 1;
  }
  rows.push(row('Active agent', 'ok', activeSlug));
  // Read the agent's own .env so the probe honors a per-agent
  // MERIDIAN_CORTEX_URL override (production agents typically point at
  // their dedicated CORTEX on a non-default port like 3101).
  const agentEnvFile = existsSync(home.envPath) ? readEnvFile(home.envPath) : {};
  const cortexUrl = agentEnvFile.MERIDIAN_CORTEX_URL || process.env.MERIDIAN_CORTEX_URL;
  const cortex = bindCortex(config.cortex.agentId, cortexUrl);
  const health = await cortex.health();
  rows.push(
    row(
      'CORTEX server reachable',
      health.status === 'ok' ? 'ok' : health.status === 'degraded' ? 'warn' : 'fail',
      `${cortex.baseUrl} status=${health.status}`,
    ),
  );

  // 5b. Memory provider — which one will the runtime pick at boot? Tells the
  // operator at a glance whether they're on the open-source CORTEX path or
  // the proprietary Quartz layer, and surfaces fallback reasons when Quartz
  // was requested but couldn't load (missing dep, missing router, etc.).
  try {
    const env = loadAgentEnv(home);
    const probeRouter = new ProviderRouter(env);
    const selection = await createMemoryProvider({
      env,
      router: probeRouter,
      cortex,
      log: () => {
        // doctor is silent about its probes; we only care about the result.
      },
    });
    const requested = env.MERIDIAN_MEMORY_PROVIDER;
    const fellBack = !!selection.fallbackReason;
    if (fellBack) {
      rows.push(
        row(
          'Memory provider',
          'warn',
          `requested=${requested}, active=${selection.selected} (fallback: ${selection.fallbackReason})`,
        ),
      );
    } else {
      rows.push(
        row(
          'Memory provider',
          'ok',
          selection.selected === 'quartz'
            ? 'quartz (proprietary; @aterna/quartz)'
            : 'cortex (open-source default)',
        ),
      );
    }
  } catch (err) {
    rows.push(row('Memory provider', 'fail', String((err as Error).message)));
  }

  // 6. Provider keys (just check presence; doctor doesn't burn tokens)
  const env = readEnvFile(home.envPath);
  rows.push(
    row(
      'Provider keys',
      env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY ? 'ok' : 'warn',
      env.OPENROUTER_API_KEY
        ? 'OpenRouter present'
        : env.ANTHROPIC_API_KEY
          ? 'Anthropic present'
          : env.OPENAI_API_KEY
            ? 'OpenAI present'
            : 'no provider keys; Ollama-only mode',
    ),
  );

  // 7. Voice channel — VAPI assistant fetch (not just key presence)
  if (env.VAPI_API_KEY && env.VAPI_ASSISTANT_ID) {
    try {
      const r = await fetch(`https://api.vapi.ai/assistant/${env.VAPI_ASSISTANT_ID}`, {
        headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
      });
      rows.push(
        row(
          'Voice channel (VAPI assistant)',
          r.ok ? 'ok' : 'fail',
          r.ok ? `assistant ${env.VAPI_ASSISTANT_ID.slice(0, 12)}…` : `HTTP ${r.status}`,
        ),
      );
    } catch (err) {
      rows.push(row('Voice channel (VAPI assistant)', 'fail', String((err as Error).message)));
    }
  } else if (env.VAPI_API_KEY) {
    rows.push(row('Voice channel', 'warn', 'key present but VAPI_ASSISTANT_ID missing'));
  } else {
    rows.push(row('Voice channel', 'skip', 'voice not provisioned'));
  }

  // 8. Telegram channel — bot getMe
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      const j = (await r.json()) as { ok: boolean; result?: { username: string } };
      rows.push(
        row(
          'Telegram channel',
          j.ok ? 'ok' : 'fail',
          j.ok ? `@${j.result?.username ?? '?'}` : 'getMe failed',
        ),
      );
    } catch (err) {
      rows.push(row('Telegram channel', 'fail', String((err as Error).message)));
    }
  } else {
    rows.push(row('Telegram channel', 'skip', 'no token'));
  }

  // 9. CORTEX live recall test — with a query CORTEX should always be able
  // to handle (no expectation of result count, just that the call works).
  if (health.status === 'ok') {
    try {
      const probe = await cortex.recall('hello', { tokenBudget: 200 });
      rows.push(
        row(
          'CORTEX recall live probe',
          'ok',
          `${probe.memories.length} memories returned (${probe.tokenCount} tokens)`,
        ),
      );
    } catch (err) {
      rows.push(row('CORTEX recall live probe', 'fail', String((err as Error).message)));
    }
  } else {
    rows.push(row('CORTEX recall live probe', 'skip', 'cortex offline'));
  }

  // 10. LLM provider chain dry-run — burn ~10 tokens to confirm the chain
  // actually works end-to-end. Uses a 1-word prompt so cost is negligible.
  try {
    let agentEnv: ReturnType<typeof loadAgentEnv>;
    try {
      agentEnv = loadAgentEnv(home);
    } catch {
      throw new Error('agent env failed schema validation');
    }
    const router = new ProviderRouter(agentEnv);
    const chain = router.chainFor('hi', config.models);
    let replied = false;
    for (const provider of chain) {
      try {
        const stream = streamText({
          model: provider.model,
          messages: [{ role: 'user', content: 'Say hi.' }],
          maxRetries: 0,
          maxSteps: 1,
        });
        let out = '';
        for await (const delta of stream.textStream) out += delta;
        if (out.trim()) {
          replied = true;
          rows.push(row('LLM chain dry-run', 'ok', `${provider.ref} responded`));
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!replied) rows.push(row('LLM chain dry-run', 'fail', 'no provider responded'));
  } catch (err) {
    rows.push(row('LLM chain dry-run', 'fail', String((err as Error).message)));
  }

  // 11. Sessions DB writable
  try {
    const probe = join(home.agentRoot, '.doctor-probe');
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    rows.push(row('Agent home writable', 'ok', home.agentRoot));
  } catch (err) {
    rows.push(row('Agent home writable', 'fail', String((err as Error).message)));
  }

  // 12. Operator config sanity
  if (config.operator) {
    const op = config.operator;
    const channelCount =
      op.channels.telegram.length + op.channels.voice.length + op.channels.cli.length;
    rows.push(
      row(
        'Operator config',
        channelCount > 0 ? 'ok' : 'warn',
        channelCount > 0
          ? `${op.id}: ${channelCount} channel binding(s)`
          : 'operator block present but no channel bindings — cross-channel continuity is off',
      ),
    );
  } else {
    rows.push(
      row(
        'Operator config',
        'warn',
        'no operator block — sessions are sandboxed per channel, no cross-channel continuity',
      ),
    );
  }

  // 13. Disk space sanity
  try {
    const fs = statfsSync(home.agentRoot);
    const freeGb = (fs.bavail * fs.bsize) / 1024 / 1024 / 1024;
    rows.push(
      row(
        'Disk space',
        freeGb > 1 ? 'ok' : freeGb > 0.25 ? 'warn' : 'fail',
        `${freeGb.toFixed(1)} GB free at ${home.agentRoot}`,
      ),
    );
  } catch {
    rows.push(row('Disk space', 'skip', 'statfs unavailable'));
  }

  // 14. SKILLS layer parse (every SKILL.md must have valid frontmatter)
  try {
    const { loadSkills } = await import('../skills/loader.js');
    const skills = await loadSkills(home);
    const dynamic = skills.list().filter((s) => s.dynamicTools).length;
    rows.push(
      row(
        'Skills parse',
        'ok',
        `${skills.list().length} skill(s) loaded cleanly${dynamic > 0 ? `, ${dynamic} with executable tools` : ''}`,
      ),
    );
  } catch (err) {
    rows.push(row('Skills parse', 'fail', String((err as Error).message)));
  }

  // 15. AUTOMATIONS parse
  try {
    const { loadAutomationDefs } = await import('../automations/manager.js');
    const defs = loadAutomationDefs(home);
    rows.push(
      row(
        'Automations parse',
        'ok',
        defs.length === 0
          ? 'none defined'
          : `${defs.length} job(s) — ${defs.map((d) => d.name).join(', ')}`,
      ),
    );
  } catch (err) {
    rows.push(row('Automations parse', 'fail', String((err as Error).message)));
  }

  rows.forEach(printRow);
  const failed = rows.filter((r) => r.status === 'fail').length;
  const warned = rows.filter((r) => r.status === 'warn').length;
  console.log('');
  if (failed === 0 && warned === 0) {
    console.log(colors.ok('Foundation healthy. All checks green.'));
  } else if (failed === 0) {
    console.log(colors.warn(`Foundation healthy with ${warned} warning(s) — review and decide.`));
  } else {
    console.log(colors.err(`Foundation has ${failed} failing check(s) and ${warned} warning(s).`));
  }
  return failed === 0 ? 0 : 1;
}
