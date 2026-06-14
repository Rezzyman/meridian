/**
 * Session, turn, and reasoning-trace persistence — a pure-JS JSONL append log
 * at ~/.meridian/<agent>/state.jsonl.
 *
 * Why not SQLite: this ships as an npm CLI, and a native dependency
 * (better-sqlite3) breaks `npm i -g` for anyone without a prebuilt binary for
 * their exact Node/arch or a working C toolchain. The session store is tiny
 * (per-agent threads + turns), so an append-only log replayed into in-memory
 * maps is plenty: O(1) writes, in-memory reads, full persistence across
 * restarts, and zero native deps — installs everywhere, always.
 *
 * Each line is one record `{ t: 'session'|'touch'|'turn'|'trace'|'audit', ... }`,
 * replayed on construction. Last write wins by id, so INSERT-OR-REPLACE
 * semantics fall out of replay order.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MeridianHome } from '../config/home.js';
import type { MeridianSession, MeridianTurn } from '../agent/types.js';

interface SessionRow {
  id: string;
  agentSlug: string;
  title?: string;
  createdAt: string;
  lastTurnAt?: string;
  branchOf?: string;
  operatorId?: string;
}

type LogRecord =
  | ({ t: 'session' } & SessionRow)
  | { t: 'touch'; id: string; lastTurnAt: string }
  | { t: 'turn'; sessionId: string; idx: number; turn: MeridianTurn }
  | { t: 'trace'; trace: TurnTrace }
  | { t: 'audit'; ts: string; kind: string; detail: unknown };

export class SessionStore {
  private readonly logPath: string;
  private readonly sessions = new Map<string, SessionRow>();
  private readonly turns = new Map<string, Map<string, { idx: number; turn: MeridianTurn }>>();
  private readonly traces = new Map<string, TurnTrace>();

  constructor(home: MeridianHome) {
    this.logPath = home.stateDb.replace(/\.db$/, '.jsonl');
    mkdirSync(dirname(this.logPath), { recursive: true });
    this.replay();
  }

  private replay(): void {
    if (!existsSync(this.logPath)) return;
    const raw = readFileSync(this.logPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        continue; // skip a torn final line
      }
      switch (rec.t) {
        case 'session': {
          const { t: _t, ...row } = rec;
          this.sessions.set(row.id, row);
          break;
        }
        case 'touch': {
          const s = this.sessions.get(rec.id);
          if (s) s.lastTurnAt = rec.lastTurnAt;
          break;
        }
        case 'turn': {
          let bucket = this.turns.get(rec.sessionId);
          if (!bucket) {
            bucket = new Map();
            this.turns.set(rec.sessionId, bucket);
          }
          bucket.set(rec.turn.id, { idx: rec.idx, turn: rec.turn });
          break;
        }
        case 'trace':
          this.traces.set(rec.trace.turnId, rec.trace);
          break;
        // 'audit' is write-only (never queried); nothing to index.
      }
    }
  }

  private write(rec: LogRecord): void {
    appendFileSync(this.logPath, `${JSON.stringify(rec)}\n`);
  }

  startSession(session: MeridianSession & { operatorId?: string }): void {
    const row: SessionRow = {
      id: session.id,
      agentSlug: session.agentSlug,
      title: session.title,
      createdAt: session.createdAt,
      branchOf: session.branchOf,
      operatorId: session.operatorId,
    };
    this.sessions.set(row.id, row);
    this.write({ t: 'session', ...row });
  }

  /** Most recent session for an operator within an idle window, or null. */
  findRecentByOperator(
    operatorId: string,
    maxIdleSec: number = 7 * 24 * 3600,
  ): MeridianSession | null {
    const cutoff = new Date(Date.now() - maxIdleSec * 1000).toISOString();
    let best: SessionRow | undefined;
    let bestAt = '';
    for (const s of this.sessions.values()) {
      if (s.operatorId !== operatorId) continue;
      const at = s.lastTurnAt ?? s.createdAt;
      if (at >= cutoff && at >= bestAt) {
        best = s;
        bestAt = at;
      }
    }
    return best ? this.loadSession(best.id) : null;
  }

  appendTurn(turn: MeridianTurn, idx: number): void {
    let bucket = this.turns.get(turn.sessionId);
    if (!bucket) {
      bucket = new Map();
      this.turns.set(turn.sessionId, bucket);
    }
    bucket.set(turn.id, { idx, turn });
    const s = this.sessions.get(turn.sessionId);
    if (s) s.lastTurnAt = turn.ts;
    this.write({ t: 'turn', sessionId: turn.sessionId, idx, turn });
    this.write({ t: 'touch', id: turn.sessionId, lastTurnAt: turn.ts });
  }

  loadSession(id: string): MeridianSession | null {
    const row = this.sessions.get(id);
    if (!row) return null;
    const turns = [...(this.turns.get(id)?.values() ?? [])]
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.turn);
    return {
      id: row.id,
      agentSlug: row.agentSlug,
      title: row.title,
      createdAt: row.createdAt,
      branchOf: row.branchOf,
      turns,
    };
  }

  listRecent(limit = 20): Array<{ id: string; title: string | null; createdAt: string }> {
    return [...this.sessions.values()]
      .sort((a, b) => (b.lastTurnAt ?? b.createdAt).localeCompare(a.lastTurnAt ?? a.createdAt))
      .slice(0, limit)
      .map((s) => ({ id: s.id, title: s.title ?? null, createdAt: s.createdAt }));
  }

  audit(kind: string, detail: unknown): void {
    this.write({ t: 'audit', ts: new Date().toISOString(), kind, detail });
  }

  // ─── Reasoning trace persistence ──
  recordTrace(trace: TurnTrace): void {
    this.traces.set(trace.turnId, trace);
    this.write({ t: 'trace', trace });
  }

  loadTrace(turnId: string): TurnTrace | null {
    return this.traces.get(turnId) ?? null;
  }

  /** Most recent N traces for a session (latest first). */
  listSessionTraces(sessionId: string, limit = 20): TurnTrace[] {
    return [...this.traces.values()]
      .filter((tr) => tr.sessionId === sessionId)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit);
  }

  close(): void {
    // Append-only + synchronous writes — nothing buffered to flush.
  }
}

// ─── Trace types ────────────────────────────────────────────────────────────────
export interface TurnTrace {
  turnId: string;
  sessionId: string;
  channel: string;
  model?: string;
  recallQuery?: string;
  recallMemoryIds?: number[];
  recallArtifactIds?: number[];
  recallTokenCount?: number;
  toolCalls?: Array<{ name: string; stepType: string; ts: string }>;
  userInput: string;
  reply: string;
  durationMs?: number;
  ts: string;
}
