import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MeridianHome } from '../config/home.js';

/**
 * Spend ledger (WS4). Every model call the runtime makes appends one record
 * to `<home>/LEDGER/spend-YYYY-MM-DD.jsonl`. Totals for today, this month,
 * and a job are derived from the files, so a restart never forgets money
 * that was already spent. USD is null when the model is unpriced.
 *
 * Why this exists: two sibling agents burned $190 a week and $208 in three
 * days in restart loops with no accounting and no cap. The harness must know
 * what a turn cost, and be able to say no, without depending on the router.
 */
export interface SpendRecord {
  ts: string;
  agentId: string;
  scope: 'turn' | 'automation' | 'other';
  sessionId?: string;
  channel?: string;
  jobId?: string;
  turnId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usd: number | null;
}

export interface SpendTotals {
  usd: number;
  /** Tokens for calls that had no price (usd null). Visible, never hidden. */
  unpricedTokens: number;
  tokens: number;
  calls: number;
}

const EMPTY = (): SpendTotals => ({ usd: 0, unpricedTokens: 0, tokens: 0, calls: 0 });

function add(t: SpendTotals, r: SpendRecord): void {
  const tokens = r.promptTokens + r.completionTokens;
  t.calls += 1;
  t.tokens += tokens;
  if (r.usd === null) t.unpricedTokens += tokens;
  else t.usd = Math.round((t.usd + r.usd) * 1_000_000) / 1_000_000;
}

export class SpendLedger {
  private readonly dir: string;
  private readonly cache = new Map<string, SpendRecord[]>();

  constructor(
    home: Pick<MeridianHome, 'agentRoot'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = join(home.agentRoot, 'LEDGER');
  }

  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private file(day: string): string {
    return join(this.dir, `spend-${day}.jsonl`);
  }

  private load(day: string): SpendRecord[] {
    const cached = this.cache.get(day);
    if (cached) return cached;
    const path = this.file(day);
    const out: SpendRecord[] = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as SpendRecord);
        } catch {
          /* a torn last line from a crash is skipped, never fatal */
        }
      }
    }
    this.cache.set(day, out);
    return out;
  }

  record(input: Omit<SpendRecord, 'ts'> & { ts?: string }): SpendRecord {
    const rec: SpendRecord = { ...input, ts: input.ts ?? this.now().toISOString() };
    const day = this.dayKey(new Date(rec.ts));
    // Warm the cache BEFORE appending, otherwise the first load reads the new
    // line back from disk and the push below counts it twice.
    const list = this.load(day);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(day), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    list.push(rec);
    return rec;
  }

  today(): SpendTotals {
    const t = EMPTY();
    for (const r of this.load(this.dayKey(this.now()))) add(t, r);
    return t;
  }

  month(): SpendTotals {
    const t = EMPTY();
    const prefix = this.dayKey(this.now()).slice(0, 7);
    if (!existsSync(this.dir)) return t;
    for (const f of readdirSync(this.dir)) {
      const m = /^spend-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m || !m[1]!.startsWith(prefix)) continue;
      for (const r of this.load(m[1]!)) add(t, r);
    }
    return t;
  }

  /** Totals for one job across the last `days` days (automation runs). */
  job(jobId: string, days = 2): SpendTotals {
    const t = EMPTY();
    const now = this.now();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(now.getTime() - i * 86_400_000);
      for (const r of this.load(this.dayKey(d))) if (r.jobId === jobId) add(t, r);
    }
    return t;
  }
}
