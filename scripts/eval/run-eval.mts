/**
 * MERIDIAN live eval — run against a real model on the dedicated
 * meridian-eval agent. Measures the parity features end-to-end:
 *
 *   1. tool-calling precision   right tool (or none) on 10 prompts
 *   2. MCP path                 external MCP tool round-trip in a live turn
 *   3. delegate path            sub-agent spawn, bounded, result used
 *   4. memory recall            encode → cross-session recall → answer
 *   5. structured output        schema-enforced JSON, repair loop
 *   6. streaming                SSE deltas live from the gateway
 *
 * Memory backend: scripts/eval/cortex-stand-in.mts (contract-faithful,
 * labeled — see that file's header). Model: ANTHROPIC_API_KEY from env.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/eval/run-eval.mts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { Conversation } from '../../src/agent/conversation.js';
import { runTurn, type TurnContext } from '../../src/agent/turn.js';
import { generateStructured } from '../../src/agent/structured.js';
import { AgentConfigSchema, defaultAgentConfig } from '../../src/config/schema.js';
import { bindCortex } from '../../src/cortex/bind.js';
import { startGateway } from '../../src/gateway/server.js';
import { connectMcpServers, McpServerConfigSchema } from '../../src/mcp/index.js';
import { ProviderRouter } from '../../src/providers/router.js';
import { delegateTools } from '../../src/skills/builtin/delegate-tools.js';
import { startCortexStandIn } from './cortex-stand-in.mts';

const MODEL = process.env.EVAL_MODEL ?? 'anthropic/claude-haiku-4-5';
const AGENT_ID = 'meridian-eval';

if (MODEL.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required for anthropic models');
  process.exit(1);
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
  // biome-ignore lint/suspicious/noExplicitAny: structural logger stub
} as any;

function makeConfig() {
  const c = defaultAgentConfig(AGENT_ID, 'Meridian Eval');
  c.models.primary = MODEL;
  c.models.fallbacks = [];
  c.models.smartRouting.enabled = false;
  c.agent.gatewayTimeoutSec = 120;
  c.cortex.encodeOnTurn = true;
  return AgentConfigSchema.parse(c);
}

interface LegResult {
  leg: string;
  passed: number;
  total: number;
  detail: string[];
  ms: number;
}

const results: LegResult[] = [];
const t0 = (): number => Date.now();

// ── Instrumented eval toolset ─────────────────────────────────────────────────
function makeTools(calls: Array<{ name: string; args: unknown }>): ToolSet {
  const probe = (name: string, description: string, params: z.ZodType) =>
    tool({
      description,
      // biome-ignore lint/suspicious/noExplicitAny: eval probe
      parameters: params as any,
      execute: async (args: unknown) => {
        calls.push({ name, args });
        if (name === 'get_weather') return { ok: true, tempC: 22, condition: 'clear' };
        if (name === 'search_invoices')
          return { ok: true, invoices: [{ id: 'INV-7', amount: 1200, customer: 'Oak Hills' }] };
        if (name === 'send_telegram') return { ok: true, sent: true };
        return { ok: true };
      },
    });
  return {
    get_weather: probe(
      'get_weather',
      'Get current weather for a city',
      z.object({ city: z.string() }),
    ),
    search_invoices: probe(
      'search_invoices',
      'Search customer invoices by customer name or id',
      z.object({ query: z.string() }),
    ),
    send_telegram: probe(
      'send_telegram',
      'Send a Telegram message to the operator',
      z.object({ text: z.string() }),
    ),
  };
}

async function main(): Promise<void> {
  const standIn = await startCortexStandIn();
  const cortexUrl = `http://127.0.0.1:${standIn.port}`;
  const cortex = bindCortex(AGENT_ID, cortexUrl);
  const env = {
    MERIDIAN_AGENT: AGENT_ID,
    CORTEX_AGENT_ID: AGENT_ID,
    NEON_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:5433/cortex_meridian_eval',
    VOYAGE_API_KEY: 'eval-stand-in-not-used-000000000',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    MERIDIAN_GATEWAY_PORT: 0,
    MERIDIAN_MEMORY_PROVIDER: 'cortex' as const,
  };
  // biome-ignore lint/suspicious/noExplicitAny: structurally AgentEnv
  const router = new ProviderRouter(env as any);
  const config = makeConfig();

  const baseCtx = (over: Partial<TurnContext>): TurnContext => ({
    sessionId: `eval-${Math.random().toString(36).slice(2, 8)}`,
    config,
    cortex,
    router,
    logger: silentLogger,
    history: [],
    channel: 'cli',
    systemBase: 'You are Meridian-Eval, a precise assistant. Use tools when they apply.',
    ...over,
  });

  // ─── Leg 1: tool-calling precision ──────────────────────────────────────────
  {
    const started = t0();
    const cases: Array<{ prompt: string; expect: string | null }> = [
      { prompt: 'What is the weather in Austin right now?', expect: 'get_weather' },
      { prompt: 'Look up the invoices for Oak Hills.', expect: 'search_invoices' },
      { prompt: 'Send me a telegram saying the deploy finished.', expect: 'send_telegram' },
      { prompt: 'How warm is it in Tokyo today?', expect: 'get_weather' },
      { prompt: 'Find invoice INV-7 and tell me the amount.', expect: 'search_invoices' },
      { prompt: 'Message me on telegram: standup moved to 10am.', expect: 'send_telegram' },
      { prompt: 'What is 17 * 23? Answer directly.', expect: null },
      { prompt: 'Write a one-line haiku about rivers.', expect: null },
      { prompt: 'Check the current weather in Reykjavik.', expect: 'get_weather' },
      { prompt: 'Do we have any invoices from customer Maple Street?', expect: 'search_invoices' },
    ];
    let passed = 0;
    const detail: string[] = [];
    for (const c of cases) {
      const calls: Array<{ name: string; args: unknown }> = [];
      try {
        await runTurn(
          baseCtx({ tools: makeTools(calls), config: { ...config, tools: { chat: [], cli: ['get_weather', 'search_invoices', 'send_telegram'] } } }),
          c.prompt,
        );
        const first = calls[0]?.name ?? null;
        const ok = c.expect === null ? calls.length === 0 : first === c.expect;
        if (ok) passed++;
        detail.push(`${ok ? 'PASS' : 'FAIL'} "${c.prompt.slice(0, 44)}" → ${first ?? 'no-tool'} (want ${c.expect ?? 'no-tool'})`);
      } catch (err) {
        detail.push(`FAIL "${c.prompt.slice(0, 44)}" → threw: ${(err as Error).message.slice(0, 60)}`);
      }
    }
    results.push({ leg: 'tool-calling precision', passed, total: cases.length, detail, ms: t0() - started });
  }

  // ─── Leg 2: MCP path (live external server, live model) ─────────────────────
  {
    const started = t0();
    const detail: string[] = [];
    let passed = 0;
    const cfg = McpServerConfigSchema.parse({
      name: 'ref',
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'mcp-ref-server.mts')],
    });
    const surface = await connectMcpServers([cfg], silentLogger);
    try {
      const res = await runTurn(
        baseCtx({
          tools: surface.tools,
          mcpGate: surface.channelGate,
          systemBase: 'You are Meridian-Eval. You have an echo tool from an MCP server.',
        }),
        "Use the echo tool with the message 'parity-proof' and tell me exactly what it returned.",
      );
      const ok = res.trace.toolCalls.some((tc) => tc.name === 'mcp_ref_echo') && /parity-proof/.test(res.reply);
      if (ok) passed++;
      detail.push(`${ok ? 'PASS' : 'FAIL'} mcp_ref_echo called=${res.trace.toolCalls.map((tc) => tc.name).join(',') || 'none'}; reply echoes=${/parity-proof/.test(res.reply)}`);
    } catch (err) {
      detail.push(`FAIL threw: ${(err as Error).message.slice(0, 80)}`);
    } finally {
      await surface.close();
    }
    results.push({ leg: 'MCP tool path (live stdio server)', passed, total: 1, detail, ms: t0() - started });
  }

  // ─── Leg 3: delegate path ────────────────────────────────────────────────────
  {
    const started = t0();
    const detail: string[] = [];
    let passed = 0;
    const calls: Array<{ name: string; args: unknown }> = [];
    const parentTools: ToolSet = { ...makeTools(calls) };
    const delTools = delegateTools({
      config,
      memory: cortex,
      router,
      logger: silentLogger,
      getParentTools: () => parentTools,
    });
    try {
      const res = await runTurn(
        baseCtx({
          tools: { ...parentTools, ...delTools },
          systemBase:
            'You are Meridian-Eval. For research-style subtasks, use the delegate tool rather than answering directly.',
        }),
        "Delegate this to a sub-agent: 'State the chemical formula of table salt in one short sentence.' Then report the sub-agent's answer verbatim.",
      );
      const delegated = res.trace.toolCalls.some((tc) => tc.name === 'delegate');
      const hasAnswer = /NaCl/i.test(res.reply);
      const ok = delegated && hasAnswer;
      if (ok) passed++;
      detail.push(`${ok ? 'PASS' : 'FAIL'} delegate called=${delegated}; child answer surfaced (NaCl)=${hasAnswer}`);
    } catch (err) {
      detail.push(`FAIL threw: ${(err as Error).message.slice(0, 80)}`);
    }
    results.push({ leg: 'delegate sub-agent path', passed, total: 1, detail, ms: t0() - started });
  }

  // ─── Leg 4: memory — encode, then cross-session recall ──────────────────────
  {
    const started = t0();
    const detail: string[] = [];
    let passed = 0;
    try {
      // Session A: tell the agent a fact (encodeOnTurn persists it).
      await runTurn(
        baseCtx({}),
        'Remember this: the staging gateway runs on port 18891 and its operator is Dana.',
      );
      await new Promise((r) => setTimeout(r, 300)); // fire-and-forget encode settles
      const encoded = standIn.dump().length > 0;

      // Session B: fresh history — only memory can answer.
      const res = await runTurn(
        baseCtx({}),
        'What port does the staging gateway run on, and who operates it?',
      );
      const recallHit = res.trace.recallMemoryIds.length > 0;
      const answered = /18891/.test(res.reply) && /dana/i.test(res.reply);
      const ok = encoded && recallHit && answered;
      if (ok) passed++;
      detail.push(
        `${ok ? 'PASS' : 'FAIL'} encoded=${encoded} (store=${standIn.dump().length}); recall hit=${recallHit} (ids=${res.trace.recallMemoryIds.length}); cross-session answer=${answered}`,
      );
    } catch (err) {
      detail.push(`FAIL threw: ${(err as Error).message.slice(0, 80)}`);
    }
    results.push({ leg: 'memory encode→recall (stand-in backend)', passed, total: 1, detail, ms: t0() - started });
  }

  // ─── Leg 5: structured output ────────────────────────────────────────────────
  {
    const started = t0();
    const detail: string[] = [];
    let passed = 0;
    const Schema = z.object({
      language: z.string(),
      year_created: z.number().int(),
      typed: z.boolean(),
    });
    try {
      const res = await generateStructured({
        router,
        models: config.models,
        schema: Schema,
        prompt: 'Facts about TypeScript: language name, year first released, statically typed?',
        logger: silentLogger,
      });
      const ok = res.object.language.toLowerCase().includes('typescript') && res.object.year_created === 2012 && res.object.typed === true;
      if (ok) passed++;
      detail.push(`${ok ? 'PASS' : 'FAIL'} object=${JSON.stringify(res.object)} attempts=${res.attempts}`);
    } catch (err) {
      detail.push(`FAIL threw: ${(err as Error).message.slice(0, 80)}`);
    }
    results.push({ leg: 'structured output (schema+repair)', passed, total: 1, detail, ms: t0() - started });
  }

  // ─── Leg 6: streaming gateway, live tokens ──────────────────────────────────
  {
    const started = t0();
    const detail: string[] = [];
    let passed = 0;
    const conversation = new Conversation({
      config,
      cortex,
      router,
      logger: silentLogger,
      systemBase: 'You are Meridian-Eval.',
      channel: 'gateway',
    });
    const app = await startGateway({ port: 0, token: 'eval-token', logger: silentLogger, conversation });
    try {
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const reqStart = t0();
      let firstDeltaMs = -1;
      let deltaCount = 0;
      let done = '';
      const res = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer eval-token' },
        body: JSON.stringify({ input: 'In about 80 words, explain what an agent harness is.' }),
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) {
          if (f.includes('event: delta')) {
            deltaCount++;
            if (firstDeltaMs < 0) firstDeltaMs = t0() - reqStart;
          }
          if (f.includes('event: done')) done = f;
        }
      }
      const totalMs = t0() - reqStart;
      const incremental = deltaCount >= 5 && firstDeltaMs > 0 && firstDeltaMs < totalMs * 0.7;
      const ok = incremental && done.includes('"reply"');
      if (ok) passed++;
      detail.push(
        `${ok ? 'PASS' : 'FAIL'} deltas=${deltaCount}; first-delta=${firstDeltaMs}ms of ${totalMs}ms total; done-event=${done.includes('"reply"')}`,
      );
    } catch (err) {
      detail.push(`FAIL threw: ${(err as Error).message.slice(0, 80)}`);
    } finally {
      await app.close();
    }
    results.push({ leg: 'SSE streaming (live tokens)', passed, total: 1, detail, ms: t0() - started });
  }

  await standIn.close();

  // ─── Report ──────────────────────────────────────────────────────────────────
  const totalPassed = results.reduce((a, r) => a + r.passed, 0);
  const totalCases = results.reduce((a, r) => a + r.total, 0);
  const lines: string[] = [
    '# MERIDIAN live eval results',
    '',
    `- date: ${new Date().toISOString()}`,
    `- model: ${MODEL}`,
    `- agent: ${AGENT_ID} (dedicated eval agent)`,
    '- memory backend: contract-faithful CORTEX stand-in (in-memory; real CORTEX provisioning blocked — see PR notes)',
    '',
    `## Score: ${totalPassed}/${totalCases}`,
    '',
  ];
  for (const r of results) {
    lines.push(`### ${r.leg} — ${r.passed}/${r.total} (${(r.ms / 1000).toFixed(1)}s)`);
    for (const d of r.detail) lines.push(`- ${d}`);
    lines.push('');
  }
  const report = lines.join('\n');
  console.log(report);
  const outDir = process.env.EVAL_OUT_DIR ?? join(process.env.HOME ?? '.', 'meridian-parity-build-2026-06-11');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'eval-results.md'), report);
  writeFileSync(join(outDir, 'eval-results.json'), JSON.stringify(results, null, 2));
  process.exit(totalPassed === totalCases ? 0 : 1);
}

main().catch((err) => {
  console.error('eval crashed:', err);
  process.exit(2);
});
