/**
 * Session and turn persistence. better-sqlite3 keyed at ~/.meridian/<agent>/state.db
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { MeridianHome } from '../config/home.js';
import type { MeridianSession, MeridianTurn } from '../agent/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_slug TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  last_turn_at TEXT,
  branch_of TEXT,
  meta_json TEXT,
  operator_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_operator ON sessions(operator_id, last_turn_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  channel TEXT NOT NULL,
  ts TEXT NOT NULL,
  memory_id INTEGER,
  tool_calls_json TEXT,
  verifications_json TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, idx);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_idx INTEGER NOT NULL,
  fs_snapshot_path TEXT,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

-- Per-turn reasoning trace. Captures the full chain (recall query, memory
-- ids, tool calls, model used, latency) so /why and /trace can answer
-- "what backed that claim?" with auditable evidence. Trust architecture.
CREATE TABLE IF NOT EXISTS turn_traces (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  model TEXT,
  recall_query TEXT,
  recall_memory_ids TEXT,
  recall_artifact_ids TEXT,
  recall_token_count INTEGER,
  tool_calls_json TEXT,
  user_input TEXT NOT NULL,
  reply TEXT NOT NULL,
  duration_ms INTEGER,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_session ON turn_traces(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_traces_ts ON turn_traces(ts DESC);
`;

export class SessionStore {
  private db: Database.Database;

  constructor(home: MeridianHome) {
    mkdirSync(dirname(home.stateDb), { recursive: true });
    this.db = new Database(home.stateDb);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Migrations: add operator_id column to existing sessions tables.
    try {
      const cols = this.db
        .prepare<[], { name: string }>(`PRAGMA table_info(sessions)`)
        .all();
      if (!cols.some((c) => c.name === 'operator_id')) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN operator_id TEXT`);
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_operator ON sessions(operator_id, last_turn_at DESC)`,
        );
      }
    } catch {
      // Best-effort; if PRAGMA fails the table is fresh and already correct.
    }
  }

  startSession(session: MeridianSession & { operatorId?: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, agent_slug, title, created_at, branch_of, meta_json, operator_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.agentSlug,
        session.title ?? null,
        session.createdAt,
        session.branchOf ?? null,
        '{}',
        session.operatorId ?? null,
      );
  }

  /**
   * Find the most recent session for a given operator id, optionally bounded
   * by an idle window (in seconds). Returns null if the operator has no
   * recent session — caller should start a new one.
   */
  findRecentByOperator(
    operatorId: string,
    maxIdleSec: number = 7 * 24 * 3600,
  ): MeridianSession | null {
    const cutoff = new Date(Date.now() - maxIdleSec * 1000).toISOString();
    const row = this.db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM sessions
         WHERE operator_id = ?
           AND COALESCE(last_turn_at, created_at) >= ?
         ORDER BY COALESCE(last_turn_at, created_at) DESC
         LIMIT 1`,
      )
      .get(operatorId, cutoff);
    if (!row) return null;
    return this.loadSession(row.id);
  }

  appendTurn(turn: MeridianTurn, idx: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turns
         (id, session_id, idx, role, content, channel, ts, memory_id, tool_calls_json, verifications_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.sessionId,
        idx,
        turn.role,
        turn.content,
        turn.channel,
        turn.ts,
        turn.memoryId ?? null,
        turn.toolCalls ? JSON.stringify(turn.toolCalls) : null,
        turn.verifications ? JSON.stringify(turn.verifications) : null,
      );
    this.db.prepare(`UPDATE sessions SET last_turn_at = ? WHERE id = ?`).run(turn.ts, turn.sessionId);
  }

  loadSession(id: string): MeridianSession | null {
    const row = this.db
      .prepare<[string], { id: string; agent_slug: string; title: string | null; created_at: string; branch_of: string | null }>(
        `SELECT id, agent_slug, title, created_at, branch_of FROM sessions WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    const turns = this.db
      .prepare<[string], MeridianTurn & { tool_calls_json: string | null; verifications_json: string | null }>(
        `SELECT id, session_id as sessionId, role, content, channel, ts, memory_id as memoryId,
                tool_calls_json, verifications_json
         FROM turns WHERE session_id = ? ORDER BY idx ASC`,
      )
      .all(id)
      .map((t) => {
        const out: MeridianTurn = {
          id: t.id,
          sessionId: t.sessionId,
          role: t.role,
          content: t.content,
          channel: t.channel,
          ts: t.ts,
          memoryId: t.memoryId ?? undefined,
        };
        if (t.tool_calls_json) out.toolCalls = JSON.parse(t.tool_calls_json);
        if (t.verifications_json) out.verifications = JSON.parse(t.verifications_json);
        return out;
      });
    return {
      id: row.id,
      agentSlug: row.agent_slug,
      title: row.title ?? undefined,
      createdAt: row.created_at,
      branchOf: row.branch_of ?? undefined,
      turns,
    };
  }

  listRecent(limit = 20): Array<{ id: string; title: string | null; createdAt: string }> {
    return this.db
      .prepare<[number], { id: string; title: string | null; createdAt: string }>(
        `SELECT id, title, created_at as createdAt FROM sessions
         ORDER BY COALESCE(last_turn_at, created_at) DESC LIMIT ?`,
      )
      .all(limit);
  }

  audit(kind: string, detail: unknown): void {
    this.db
      .prepare(`INSERT INTO audit_log (ts, kind, detail_json) VALUES (?, ?, ?)`)
      .run(new Date().toISOString(), kind, JSON.stringify(detail));
  }

  // ─── Reasoning trace persistence ──
  recordTrace(trace: TurnTrace): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn_traces
         (turn_id, session_id, channel, model, recall_query, recall_memory_ids,
          recall_artifact_ids, recall_token_count, tool_calls_json,
          user_input, reply, duration_ms, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.turnId,
        trace.sessionId,
        trace.channel,
        trace.model ?? null,
        trace.recallQuery ?? null,
        trace.recallMemoryIds ? JSON.stringify(trace.recallMemoryIds) : null,
        trace.recallArtifactIds ? JSON.stringify(trace.recallArtifactIds) : null,
        trace.recallTokenCount ?? null,
        trace.toolCalls ? JSON.stringify(trace.toolCalls) : null,
        trace.userInput,
        trace.reply,
        trace.durationMs ?? null,
        trace.ts,
      );
  }

  loadTrace(turnId: string): TurnTrace | null {
    const row = this.db
      .prepare<[string], TurnTraceRow>(
        `SELECT turn_id, session_id, channel, model, recall_query,
                recall_memory_ids, recall_artifact_ids, recall_token_count,
                tool_calls_json, user_input, reply, duration_ms, ts
         FROM turn_traces WHERE turn_id = ?`,
      )
      .get(turnId);
    if (!row) return null;
    return rowToTrace(row);
  }

  /** Most recent N traces for a session (default: latest first). */
  listSessionTraces(sessionId: string, limit = 20): TurnTrace[] {
    const rows = this.db
      .prepare<[string, number], TurnTraceRow>(
        `SELECT turn_id, session_id, channel, model, recall_query,
                recall_memory_ids, recall_artifact_ids, recall_token_count,
                tool_calls_json, user_input, reply, duration_ms, ts
         FROM turn_traces WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map(rowToTrace);
  }

  close(): void {
    this.db.close();
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

interface TurnTraceRow {
  turn_id: string;
  session_id: string;
  channel: string;
  model: string | null;
  recall_query: string | null;
  recall_memory_ids: string | null;
  recall_artifact_ids: string | null;
  recall_token_count: number | null;
  tool_calls_json: string | null;
  user_input: string;
  reply: string;
  duration_ms: number | null;
  ts: string;
}

function rowToTrace(row: TurnTraceRow): TurnTrace {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    channel: row.channel,
    model: row.model ?? undefined,
    recallQuery: row.recall_query ?? undefined,
    recallMemoryIds: row.recall_memory_ids
      ? (JSON.parse(row.recall_memory_ids) as number[])
      : undefined,
    recallArtifactIds: row.recall_artifact_ids
      ? (JSON.parse(row.recall_artifact_ids) as number[])
      : undefined,
    recallTokenCount: row.recall_token_count ?? undefined,
    toolCalls: row.tool_calls_json
      ? (JSON.parse(row.tool_calls_json) as TurnTrace['toolCalls'])
      : undefined,
    userInput: row.user_input,
    reply: row.reply,
    durationMs: row.duration_ms ?? undefined,
    ts: row.ts,
  };
}
