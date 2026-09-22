#!/usr/bin/env -S node --import tsx
/**
 * Harness parity bench runner (WS6). See benchmarks/harness-parity-v1/README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import {
  checkReply,
  judgeParity,
  judgePrompt,
  parseJudge,
  percentile,
  type HarnessRun,
  type MemoryCase,
  type PromptCase,
} from '../src/bench/parity.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

interface Target {
  name: string;
  url: string;
  token: string;
}
function parseTarget(spec: string | undefined, label: string): Target {
  if (!spec) throw new Error(`--${label} name=url,token is required`);
  const [name, rest] = spec.split('=', 2);
  const [url, token] = (rest ?? '').split(',', 2);
  if (!name || !url || !token) throw new Error(`--${label} must be name=url,token`);
  return { name, url: url.replace(/\/$/, ''), token };
}

const A = parseTarget(opt('a'), 'a');
const B = parseTarget(opt('b'), 'b');
const out =
  opt('out') ??
  join(root, `benchmarks/harness-parity-v1/results-${new Date().toISOString().slice(0, 10)}.json`);
const reliabilityTurns = Number(opt('reliability') ?? 100);
const judgeModel = opt('judge');
const skipMemory = flag('no-memory');

const prompts = JSON.parse(
  readFileSync(join(root, 'benchmarks/harness-parity-v1/prompts.json'), 'utf8'),
) as PromptCase[];
const memory = JSON.parse(
  readFileSync(join(root, 'benchmarks/harness-parity-v1/memory.json'), 'utf8'),
) as MemoryCase[];

async function ask(
  t: Target,
  prompt: string,
): Promise<{ text: string; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${t.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ model: 'bench', messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { text: '', ms, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content ?? '';
    return text ? { text, ms } : { text: '', ms, error: 'empty completion' };
  } catch (err) {
    return { text: '', ms: Date.now() - started, error: (err as Error).message };
  }
}

async function runHarness(
  t: Target,
): Promise<{ run: HarnessRun; replies: Record<string, string> }> {
  console.log(`\n== ${t.name} @ ${t.url}`);
  const replies: Record<string, string> = {};
  const failures: Record<string, string[]> = {};
  let passed = 0;
  const latencies: number[] = [];
  let errors = 0;
  for (const c of prompts) {
    const r = await ask(t, c.prompt);
    replies[c.id] = r.text;
    latencies.push(r.ms);
    if (r.error) errors += 1;
    const check = r.error ? { ok: false, failures: [r.error] } : checkReply(c, r.text);
    if (check.ok) passed += 1;
    else failures[c.id] = check.failures;
    console.log(
      `  ${check.ok ? 'PASS' : 'FAIL'} ${c.id} ${c.category.padEnd(12)} ${r.ms}ms ${check.ok ? '' : check.failures.join('; ')}`,
    );
  }
  const misses: string[] = [];
  let hits = 0;
  if (!skipMemory) {
    console.log('  memory: seeding');
    for (const m of memory) await ask(t, m.seed);
    await new Promise((r) => setTimeout(r, 8000));
    for (const m of memory) {
      const r = await ask(t, m.ask);
      const hit = !r.error && new RegExp(m.expect, 'i').test(r.text);
      if (hit) hits += 1;
      else misses.push(`${m.id}: ${r.error ?? r.text.slice(0, 80).replace(/\n/g, ' ')}`);
      console.log(`  ${hit ? 'HIT ' : 'MISS'} ${m.id}`);
    }
  }
  const extra = Math.max(0, reliabilityTurns - prompts.length);
  for (let i = 0; i < extra; i += 1) {
    const c = prompts[i % prompts.length]!;
    const r = await ask(t, c.prompt);
    latencies.push(r.ms);
    if (r.error) errors += 1;
  }
  const run: HarnessRun = {
    name: t.name,
    functional: { total: prompts.length, passed, failures },
    memory: skipMemory
      ? { total: 0, hits: 0, misses: ['skipped (--no-memory)'] }
      : { total: memory.length, hits, misses },
    reliability: {
      turns: latencies.length,
      errors,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
    },
    humanFeel: 'unmeasured',
    usdPerTurn: 'unmeasured',
  };
  return { run, replies };
}

async function judge(
  aReplies: Record<string, string>,
  bReplies: Record<string, string>,
): Promise<{ comparisons: number; preferred: number; ties: number }> {
  if (!judgeModel) return { comparisons: 0, preferred: 0, ties: 0 };
  const key = process.env.ROUTEXOR_API_KEY;
  if (!key) throw new Error('ROUTEXOR_API_KEY is required for --judge');
  const rx = createOpenAI({
    apiKey: key,
    baseURL: process.env.ROUTEXOR_BASE_URL ?? 'https://api.routexor.com/v1',
    name: 'routexor',
  });
  const modelId = judgeModel.replace(/^routexor\//, '');
  let comparisons = 0;
  let preferred = 0;
  let ties = 0;
  for (const c of prompts) {
    const a = aReplies[c.id] ?? '';
    const b = bReplies[c.id] ?? '';
    if (!a || !b) continue;
    const swap = Math.random() < 0.5;
    const { text } = await generateText({
      model: rx(modelId),
      prompt: judgePrompt(c.prompt, swap ? b : a, swap ? a : b),
      maxTokens: 120,
    });
    const v = parseJudge(text);
    if (!v) continue;
    comparisons += 1;
    if (v === 'tie') ties += 1;
    else if ((v === 'A') !== swap) preferred += 1;
  }
  return { comparisons, preferred, ties };
}

const a = await runHarness(A);
const b = await runHarness(B);
const hf = await judge(a.replies, b.replies);
if (hf.comparisons > 0) a.run.humanFeel = { comparisons: hf.comparisons, preferred: hf.preferred };
const verdict = judgeParity(a.run, b.run);
const results = {
  schema: 'meridian.harness-parity.v1',
  ranAt: new Date().toISOString(),
  targets: { a: { name: A.name, url: A.url }, b: { name: B.name, url: B.url } },
  judgeModel: judgeModel ?? null,
  a: a.run,
  b: b.run,
  humanFeelTies: hf.ties,
  verdict,
  replies: { a: a.replies, b: b.replies },
};
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\n${verdict.ok ? 'PARITY PASS' : 'PARITY FAIL'} ${verdict.reasons.join('; ')}`);
console.log(`results: ${out}`);
process.exit(verdict.ok ? 0 : 1);
