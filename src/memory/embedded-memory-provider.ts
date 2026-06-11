/**
 * EmbeddedMemoryProvider — zero-config local memory. No CORTEX server, no
 * Neon, no Voyage, no native module. Pure JS + an append-only JSONL file in
 * the agent home. `meridian init demo --embedded` then `meridian` gives a
 * talking agent that REMEMBERS you across sessions in under a minute, with
 * zero external dependencies.
 *
 * Recall is TF-IDF keyword scoring over the local corpus — genuinely useful
 * for a personal store (rare terms weigh more than common ones), and it
 * satisfies the same MemoryProvider contract CORTEX/Quartz do, so the rest of
 * the runtime — crucially the memory-poisoning screen in the turn loop — works
 * identically on embedded memory. Zero-config AND safe-by-default.
 *
 * It is deliberately NOT CORTEX: no hippocampal pipeline, no embeddings, no
 * dream consolidation, no scale past ~tens of thousands of memories. It is the
 * on-ramp; CORTEX (open-source) and Quartz (paid) are the path to semantic
 * recall and scale. Upgrading is a config flag, not a rewrite.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CortexHealth,
  CortexStats,
  DreamCycleResult,
  EncodeResult,
  RecallMemory,
  RecallResult,
  ValenceVector,
} from '../cortex/types.js';
import type {
  DreamCycleType,
  EncodeOptions,
  ListArtifactsOptions,
  ListArtifactsResult,
  MemoryProvider,
  RecallOptions,
} from './provider.js';

interface EmbeddedRecord {
  id: number;
  content: string;
  source: string | null;
  sensitivity: 'public' | 'internal' | 'sacred';
  channel: string | null;
  valence?: Partial<ValenceVector>;
  createdAt: string;
  lastRecalledAt: string | null;
}

const STOPWORDS = new Set(
  'a an the and or but of to in on at for with is are was were be been being i you he she it we they me my your his her our their this that these those do does did have has had will would can could should may might as from by about into over after before under than then so if not no yes me us them what which who whom whose how when where why'.split(
    ' ',
  ),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface EmbeddedMemoryOptions {
  agentId: string;
  /** JSONL file path; created (with parents) if missing. */
  dbPath: string;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

export class EmbeddedMemoryProvider implements MemoryProvider {
  readonly agentId: string;
  private readonly dbPath: string;
  private readonly log: (level: 'info' | 'warn', msg: string) => void;
  private records: EmbeddedRecord[] = [];
  private docFreq = new Map<string, number>();
  private nextId = 1;

  constructor(opts: EmbeddedMemoryOptions) {
    this.agentId = opts.agentId;
    this.dbPath = opts.dbPath;
    this.log = opts.log ?? (() => {});
    this.load();
  }

  private load(): void {
    if (!existsSync(this.dbPath)) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      return;
    }
    const lines = readFileSync(this.dbPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as EmbeddedRecord;
        this.records.push(rec);
        this.indexDoc(rec.content);
        this.nextId = Math.max(this.nextId, rec.id + 1);
      } catch {
        // skip a corrupt line; one bad append never bricks recall
      }
    }
    this.log('info', `embedded memory: ${this.records.length} memories at ${this.dbPath}`);
  }

  private indexDoc(content: string): void {
    for (const term of new Set(tokenize(content))) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
  }

  private idf(term: string): number {
    const df = this.docFreq.get(term) ?? 0;
    // Smoothed IDF; rarer terms weigh more.
    return Math.log((this.records.length + 1) / (df + 1)) + 1;
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const tokenBudget = opts.tokenBudget ?? 1500;
    const allowed = opts.sensitivityFilter;
    const since = opts.since
      ? new Date(typeof opts.since === 'string' ? opts.since : opts.since.toISOString()).getTime()
      : undefined;

    const qTerms = new Set(tokenize(query));
    if (qTerms.size === 0) {
      return { context: '', memories: [], artifacts: [], tokenCount: 0, tokenBudget };
    }

    const scored: Array<{ rec: EmbeddedRecord; score: number }> = [];
    for (const rec of this.records) {
      if (allowed && !allowed.includes(rec.sensitivity)) continue;
      if (since !== undefined) {
        const created = new Date(rec.createdAt).getTime();
        const recalled = rec.lastRecalledAt ? new Date(rec.lastRecalledAt).getTime() : 0;
        if (created < since && recalled < since) continue;
      }
      const docTerms = new Set(tokenize(rec.content));
      let score = 0;
      for (const t of qTerms) if (docTerms.has(t)) score += this.idf(t);
      if (score > 0) scored.push({ rec, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const maxScore = scored[0]?.score ?? 1;

    const memories: RecallMemory[] = [];
    let used = 0;
    const nowIso = new Date().toISOString();
    const lines: string[] = [];
    for (const { rec, score } of scored) {
      const cost = approxTokens(rec.content);
      if (used + cost > tokenBudget && memories.length > 0) break;
      used += cost;
      memories.push({
        id: rec.id,
        content: rec.content,
        source: rec.source,
        score: Number((score / maxScore).toFixed(4)),
      });
      lines.push(`- ${rec.content}`);
      rec.lastRecalledAt = nowIso;
      if (memories.length >= 12) break;
    }

    return {
      context: lines.join('\n'),
      memories,
      artifacts: [],
      tokenCount: used,
      tokenBudget,
    };
  }

  async encode(content: string, opts: EncodeOptions = {}): Promise<EncodeResult> {
    const novelty = this.computeNovelty(content);
    const rec: EmbeddedRecord = {
      id: this.nextId++,
      content,
      source: opts.source ?? 'embedded:encode',
      sensitivity: opts.sensitivity ?? 'internal',
      channel: opts.channel ?? null,
      valence: opts.valence,
      createdAt: new Date().toISOString(),
      lastRecalledAt: null,
    };
    this.records.push(rec);
    this.indexDoc(content);
    try {
      appendFileSync(this.dbPath, `${JSON.stringify(rec)}\n`);
    } catch (err) {
      this.log('warn', `embedded encode persist failed: ${(err as Error).message}`);
    }
    return { memoryId: rec.id, novelty, encoded: true, valence: opts.valence as ValenceVector };
  }

  /** Cheap novelty: 1 − max Jaccard similarity to any existing memory. */
  private computeNovelty(content: string): number {
    const terms = new Set(tokenize(content));
    if (terms.size === 0 || this.records.length === 0) return 1;
    let maxSim = 0;
    for (const rec of this.records) {
      const other = new Set(tokenize(rec.content));
      let inter = 0;
      for (const t of terms) if (other.has(t)) inter++;
      const union = terms.size + other.size - inter;
      const sim = union === 0 ? 0 : inter / union;
      if (sim > maxSim) maxSim = sim;
    }
    return Number((1 - maxSim).toFixed(3));
  }

  async listArtifacts(opts: ListArtifactsOptions = {}): Promise<ListArtifactsResult> {
    return {
      agentId: this.agentId,
      sinceHours: opts.sinceHours ?? 48,
      cutoff: new Date().toISOString(),
      count: 0,
      artifacts: [],
    };
  }

  async dream(cycleType: DreamCycleType = 'full'): Promise<DreamCycleResult> {
    // Embedded memory has no consolidation pipeline; this is a no-op that
    // reports honestly rather than pretending to dream.
    return {
      cycleType,
      durationMs: 0,
      insights: [],
      stats: { memoryCount: this.records.length, note: 'embedded provider: no consolidation' },
    };
  }

  async health(): Promise<CortexHealth> {
    return { status: 'ok', database: 'connected', memoryCount: this.records.length };
  }

  async stats(): Promise<CortexStats> {
    return {
      memoryCount: this.records.length,
      synapseCount: 0,
      artifactCount: 0,
      lastDreamAt: null,
      agentId: this.agentId,
    };
  }

  async reconsolidate(memoryId: number, content: string): Promise<{ ok: boolean }> {
    const rec = this.records.find((r) => r.id === memoryId);
    if (!rec) return { ok: false };
    rec.content = content;
    this.rewrite();
    return { ok: true };
  }

  /** Rewrite the whole JSONL (used by reconsolidate; encode stays append-only). */
  private rewrite(): void {
    try {
      writeFileSync(this.dbPath, `${this.records.map((r) => JSON.stringify(r)).join('\n')}\n`);
      this.docFreq.clear();
      for (const r of this.records) this.indexDoc(r.content);
    } catch (err) {
      this.log('warn', `embedded rewrite failed: ${(err as Error).message}`);
    }
  }
}
