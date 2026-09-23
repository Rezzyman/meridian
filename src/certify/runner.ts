import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { checkReply, type PromptCase } from '../bench/parity.js';
import type { Capability, CapabilityManifest, Probe } from './manifest.js';
import { missingRequired } from './manifest.js';

/**
 * `meridian certify` runner (certification step 1). Executes every probe in a
 * manifest against a live gateway and produces a card: one row per claim,
 * green, red, or needs-human, with the evidence line. Certification passes
 * only when every blocking claim is green (a manual claim is green only when
 * the operator attests it on the command line with --confirm <id>).
 */
export type ProbeStatus = 'green' | 'red' | 'manual' | 'skipped';

export interface ProbeResult {
  id: string;
  claim: string;
  severity: Capability['severity'];
  status: ProbeStatus;
  evidence: string;
  durationMs: number;
}

export interface CertifyReport {
  schema: 'meridian.certification.v1';
  agent: string;
  audience: CapabilityManifest['audience'];
  gateway: string;
  ranAt: string;
  results: ProbeResult[];
  missingRequired: string[];
  certified: boolean;
  reasons: string[];
}

export interface CertifyTarget {
  gateway: string;
  /** Directory the manifest was loaded from; golden `file` resolves against it. */
  manifestDir?: string;
  token?: string;
  /** Values for {{marker}} style placeholders; a fresh marker per run by default. */
  vars?: Record<string, string>;
  /** Manual claims the operator attests to this run. */
  confirmed?: Set<string>;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
}

function pick(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

export async function runProbe(cap: Capability, t: CertifyTarget): Promise<ProbeResult> {
  const f = t.fetchImpl ?? fetch;
  const sleep = t.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = t.now ?? Date.now;
  const vars = t.vars ?? {};
  const auth: Record<string, string> = t.token ? { authorization: `Bearer ${t.token}` } : {};
  const base = t.gateway.replace(/\/$/, '');
  const started = now();
  const done = (status: ProbeStatus, evidence: string): ProbeResult => ({
    id: cap.id,
    claim: cap.claim,
    severity: cap.severity,
    status,
    evidence,
    durationMs: now() - started,
  });
  const p: Probe = cap.probe;
  try {
    switch (p.kind) {
      case 'health': {
        const res = await f(`${base}/health`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return done('red', `GET /health HTTP ${res.status}`);
        const body = (await res.json()) as unknown;
        const v = pick(body, p.field);
        if (p.equals !== undefined) {
          return v === p.equals
            ? done('green', `${p.field} = ${JSON.stringify(v)}`)
            : done(
                'red',
                `${p.field} = ${JSON.stringify(v)}, expected ${JSON.stringify(p.equals)}`,
              );
        }
        if (p.truthy)
          return v
            ? done('green', `${p.field} = ${JSON.stringify(v)}`)
            : done('red', `${p.field} is ${JSON.stringify(v)}`);
        return v !== undefined
          ? done('green', `${p.field} present`)
          : done('red', `${p.field} missing`);
      }
      case 'turn': {
        const res = await f(`${base}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ input: fill(p.input, vars) }),
          signal: AbortSignal.timeout(p.withinMs),
        });
        if (!res.ok) return done('red', `POST /chat HTTP ${res.status}`);
        const reply = String(((await res.json()) as { reply?: string }).reply ?? '').trim();
        if (!reply) return done('red', 'empty reply');
        for (const re of p.mustMatch)
          if (!new RegExp(re, 'i').test(reply))
            return done('red', `missing /${re}/ in: ${reply.slice(0, 120)}`);
        for (const re of p.mustNotMatch)
          if (new RegExp(re, 'i').test(reply))
            return done('red', `forbidden /${re}/ in: ${reply.slice(0, 120)}`);
        return done('green', `${now() - started}ms: ${reply.slice(0, 100).replace(/\n/g, ' ')}`);
      }
      case 'memory': {
        // Seed on a fresh stateless session, then poll fresh sessions until the
        // fact is recalled. This is the protocol the parity bench got wrong:
        // Meridian writes memory in the background, so "ask 8 seconds later"
        // measures the write latency, not recall.
        const complete = async (input: string): Promise<string> => {
          const res = await f(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth },
            body: JSON.stringify({
              model: 'meridian',
              messages: [{ role: 'user', content: input }],
            }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) throw new Error(`completions HTTP ${res.status}`);
          const b = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          return b.choices?.[0]?.message?.content ?? '';
        };
        await complete(fill(p.seed, vars));
        const expect = new RegExp(fill(p.expect, vars), 'i');
        let attempts = 0;
        let last = '';
        while (now() - started < p.withinMs) {
          await sleep(Math.min(10_000, 3000 + attempts * 2000));
          attempts += 1;
          last = await complete(fill(p.ask, vars));
          if (expect.test(last))
            return done(
              'green',
              `recalled after ${now() - started}ms (${attempts} ask${attempts === 1 ? '' : 's'})`,
            );
        }
        return done(
          'red',
          `not recalled within ${p.withinMs}ms after ${attempts} asks; last: ${last.slice(0, 100).replace(/\n/g, ' ')}`,
        );
      }
      case 'tools': {
        const res = await f(`${base}/tools`, {
          headers: { ...auth },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return done('red', `GET /tools HTTP ${res.status}`);
        const have = new Set(((await res.json()) as { tools?: string[] }).tools ?? []);
        const missing = p.names.filter((n) => !have.has(n));
        return missing.length
          ? done('red', `missing tools: ${missing.join(', ')}`)
          : done('green', `${p.names.length} tool(s) present`);
      }
      case 'automation': {
        const res = await f(`${base}/health`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return done('red', `GET /health HTTP ${res.status}`);
        const autos =
          (pick(await res.json(), 'automations') as Array<{
            name: string;
            nextFireAt: string | null;
            delivers: boolean;
            graduatedAt: string | null;
            requiresApproval: boolean;
          }>) ?? [];
        const a = autos.find((x) => x.name === p.name);
        if (!a) return done('red', `automation ${p.name} not armed`);
        if (!a.nextFireAt) return done('red', `${p.name} armed but has no next fire time`);
        if (p.delivers && !a.delivers)
          return done('red', `${p.name} will not deliver (mode/autonomy/pushTo)`);
        return done(
          'green',
          `${p.name} next ${a.nextFireAt}${a.requiresApproval && !a.graduatedAt ? ' (approval-gated)' : ''}`,
        );
      }
      case 'http': {
        const res = await f(p.url, { signal: AbortSignal.timeout(p.withinMs) });
        return res.ok
          ? done('green', `${p.url} HTTP ${res.status}`)
          : done('red', `${p.url} HTTP ${res.status}`);
      }
      case 'loop-canary': {
        const token = t.env?.[p.tokenEnv];
        if (!token) return done('skipped', `${p.tokenEnv} not set`);
        const r = await loopCanary(p.url, token, f);
        return r.ok ? done('green', r.detail) : done('red', r.detail);
      }
      case 'manual':
        return t.confirmed?.has(cap.id)
          ? done('green', `attested by operator: ${p.instruction}`)
          : done('manual', p.instruction);
    }
  } catch (err) {
    return done('red', (err as Error).message.slice(0, 160));
  }
}

/** The Loop contract check, same as scripts/ops/loop-canary.mjs. */
export async function loopCanary(
  url: string,
  token: string,
  f: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const segmentId = randomUUID();
  const excerpt = 'Canary note: the lawn service comes on Thursdays at nine in the morning.';
  const evidence = [
    {
      lifelogId: randomUUID(),
      segmentId,
      startedAt: '2026-09-22T09:00:00Z',
      endedAt: '2026-09-22T09:01:00Z',
      excerpt,
      sha256: createHash('sha256').update(excerpt, 'utf8').digest('hex'),
    },
  ];
  const frame = (v: string) =>
    Buffer.concat([
      Buffer.from(String(Buffer.byteLength(v, 'utf8'))),
      Buffer.from(':'),
      Buffer.from(v, 'utf8'),
    ]);
  const corpus = createHash('sha256');
  for (const e of evidence)
    for (const v of [e.lifelogId, e.segmentId, e.startedAt, e.endedAt, e.sha256])
      corpus.update(frame(v));
  const body = {
    schemaVersion: 'aterna.loop.turn.v1',
    requestId: randomUUID(),
    threadId: randomUUID(),
    question: 'What day does the lawn service come?',
    sourceCorpusSha256: corpus.digest('hex'),
    intervalStart: '2026-09-22T00:00:00Z',
    intervalEnd: '2026-09-23T00:00:00Z',
    timeZoneIdentifier: 'America/Denver',
    evidence,
  };
  const unauth = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (unauth.status !== 401)
    return { ok: false, detail: `unauthenticated request was ${unauth.status}, expected 401` };
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status !== 200) return { ok: false, detail: `authenticated request was ${res.status}` };
  const r = (await res.json()) as {
    schemaVersion?: string;
    requestId?: string;
    toolExecution?: string;
    memoryWrite?: string;
    text?: string;
    citedSegmentIds?: string[];
  };
  const problems: string[] = [];
  if (r.schemaVersion !== 'aterna.loop.reply.v1') problems.push('schema');
  if (r.requestId !== body.requestId) problems.push('requestId');
  if (r.toolExecution !== 'disabled' || r.memoryWrite !== 'disabled')
    problems.push('isolation attestation');
  if (!r.text) problems.push('empty text');
  if (!r.citedSegmentIds?.includes(segmentId)) problems.push('citation');
  if (!/thursday/i.test(r.text ?? '')) problems.push('grounding');
  return problems.length
    ? { ok: false, detail: `loop canary failed: ${problems.join(', ')}` }
    : {
        ok: true,
        detail: 'loop canary passed: 401 unauth, 200 cited, tools and memory writes disabled',
      };
}

/** Run the golden set (the agent's own job as prompts) through stateless,
 *  text-styled completions and score the pass rate. */
export async function runGolden(
  manifest: CapabilityManifest,
  t: CertifyTarget,
): Promise<ProbeResult | null> {
  const g = manifest.golden;
  if (!g) return null;
  const f = t.fetchImpl ?? fetch;
  const now = t.now ?? Date.now;
  const started = now();
  const path = isAbsolute(g.file) ? g.file : resolve(t.manifestDir ?? process.cwd(), g.file);
  let cases: PromptCase[];
  try {
    cases = JSON.parse(readFileSync(path, 'utf8')) as PromptCase[];
  } catch (err) {
    return {
      id: 'golden',
      claim: `Golden set ${g.file}`,
      severity: g.severity,
      status: 'red',
      evidence: `cannot read golden set: ${(err as Error).message}`,
      durationMs: now() - started,
    };
  }
  const auth: Record<string, string> = t.token ? { authorization: `Bearer ${t.token}` } : {};
  const failures: string[] = [];
  let passed = 0;
  for (const c of cases) {
    try {
      const res = await f(`${t.gateway.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-meridian-text-style': '1', ...auth },
        body: JSON.stringify({
          model: 'meridian',
          messages: [{ role: 'user', content: c.prompt }],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        failures.push(`${c.id}: HTTP ${res.status}`);
        continue;
      }
      const b = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const check = checkReply(c, b.choices?.[0]?.message?.content ?? '');
      if (check.ok) passed += 1;
      else failures.push(`${c.id}: ${check.failures.join(', ')}`);
    } catch (err) {
      failures.push(`${c.id}: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  const rate = cases.length ? passed / cases.length : 0;
  const more = failures.length > 6 ? ` | +${failures.length - 6} more` : '';
  return {
    id: 'golden',
    claim: `Golden set: at least ${Math.round(g.minPassRate * 100)}% of ${cases.length} job prompts pass`,
    severity: g.severity,
    status: rate >= g.minPassRate ? 'green' : 'red',
    evidence: `${passed}/${cases.length} passed${failures.length ? `; ${failures.slice(0, 6).join(' | ')}${more}` : ''}`,
    durationMs: now() - started,
  };
}

export async function certify(
  manifest: CapabilityManifest,
  target: CertifyTarget,
): Promise<CertifyReport> {
  const vars = { marker: `cert-${randomUUID().slice(0, 8)}`, ...(target.vars ?? {}) };
  const t = { ...target, vars };
  const results: ProbeResult[] = [];
  for (const cap of manifest.capabilities) results.push(await runProbe(cap, t));
  const golden = await runGolden(manifest, t);
  if (golden) results.push(golden);
  const missing = missingRequired(manifest);
  const reasons: string[] = [];
  for (const id of missing) reasons.push(`required capability not promised: ${id}`);
  // At least one operator channel must be green, whatever each channel's own
  // severity: an agent nobody can reach is not certified.
  const channelIds = manifest.capabilities.filter((c) => c.channel).map((c) => c.id);
  if (
    channelIds.length > 0 &&
    !results.some((r) => channelIds.includes(r.id) && r.status === 'green')
  ) {
    reasons.push(`no operator channel is green (${channelIds.join(', ')}); at least one must be`);
  }
  for (const r of results) {
    if (r.severity !== 'blocking') continue;
    if (r.status === 'red') reasons.push(`${r.id}: ${r.evidence}`);
    if (r.status === 'manual')
      reasons.push(`${r.id}: needs operator attestation (--confirm ${r.id})`);
  }
  return {
    schema: 'meridian.certification.v1',
    agent: manifest.agent,
    audience: manifest.audience,
    gateway: target.gateway,
    ranAt: new Date().toISOString(),
    results,
    missingRequired: missing,
    certified: reasons.length === 0,
    reasons,
  };
}

export function renderCard(report: CertifyReport): string {
  const mark = (s: ProbeStatus) =>
    ({ green: ' ok ', red: 'FAIL', manual: 'HUMAN', skipped: 'skip' })[s];
  const lines = [`Certification · ${report.agent} (${report.audience}) · ${report.gateway}`, ''];
  for (const r of report.results) {
    lines.push(`  ${mark(r.status).padEnd(5)} ${r.id.padEnd(26)} ${r.claim}`);
    lines.push(`        ${r.evidence}`);
  }
  lines.push('');
  lines.push(
    report.certified
      ? 'CERTIFIED: every blocking claim is green.'
      : `NOT CERTIFIED:\n  ${report.reasons.join('\n  ')}`,
  );
  return lines.join('\n');
}
