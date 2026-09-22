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

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { MeridianHome } from '../config/home.js';
import type { MeridianSession, MeridianTurn } from '../agent/types.js';
import type { ActionReceiptInput } from '../governance/action-policy.js';

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
  | { t: 'action'; receipt: ActionReceipt }
  | { t: 'approval'; grant: ApprovalGrant }
  | { t: 'audit'; ts: string; kind: string; detail: unknown };

export class SessionStore {
  private readonly logPath: string;
  private readonly sessions = new Map<string, SessionRow>();
  private readonly turns = new Map<string, Map<string, { idx: number; turn: MeridianTurn }>>();
  private readonly traces = new Map<string, TurnTrace>();
  private readonly actions = new Map<string, ActionReceipt>();
  private readonly approvals = new Map<string, ApprovalGrant>();
  private readonly actionKey: Buffer;
  private lastActionHash = 'GENESIS';

  constructor(home: MeridianHome) {
    this.logPath = home.stateDb.replace(/\.db$/, '.jsonl');
    mkdirSync(dirname(this.logPath), { recursive: true });
    const keyPath = `${this.logPath}.action-key`;
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
      chmodSync(keyPath, 0o600);
    }
    this.actionKey = readFileSync(keyPath);
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
        case 'action':
          this.actions.set(rec.receipt.receiptId, rec.receipt);
          this.lastActionHash = rec.receipt.hash;
          break;
        case 'approval':
          this.approvals.set(rec.grant.grantId, rec.grant);
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

  digestActionArgs(args: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(args ?? null))
      .digest('hex');
  }

  recordActionReceipt(input: ActionReceiptInput): ActionReceipt {
    const unsigned = { ...input, previousHash: this.lastActionHash };
    const hash = createHmac('sha256', this.actionKey)
      .update(JSON.stringify(unsigned))
      .digest('hex');
    const receipt: ActionReceipt = { ...unsigned, hash };
    this.actions.set(receipt.receiptId, receipt);
    this.lastActionHash = hash;
    this.write({ t: 'action', receipt });
    return receipt;
  }

  listActionReceipts(sessionId?: string, limit = 100): ActionReceipt[] {
    return [...this.actions.values()]
      .filter((r) => !sessionId || r.sessionId === sessionId)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit);
  }

  verifyActionReceipt(receipt: ActionReceipt): boolean {
    const { hash, ...unsigned } = receipt;
    const expected = createHmac('sha256', this.actionKey)
      .update(JSON.stringify(unsigned))
      .digest('hex');
    return expected === hash;
  }

  verifyActionChain(): boolean {
    let previous = 'GENESIS';
    for (const receipt of this.actions.values()) {
      if (receipt.previousHash !== previous || !this.verifyActionReceipt(receipt)) return false;
      previous = receipt.hash;
    }
    return true;
  }

  grantApproval(
    sessionId: string,
    toolName: string,
    ttlMinutes = 5,
    argsDigest?: string,
  ): ApprovalGrant {
    const now = Date.now();
    const unsigned = {
      grantId: `appr_${randomBytes(12).toString('hex')}`,
      sessionId,
      toolName,
      argsDigest,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMinutes * 60_000).toISOString(),
      remainingUses: 1,
    };
    const signature = createHmac('sha256', this.actionKey)
      .update(JSON.stringify(unsigned))
      .digest('hex');
    const grant: ApprovalGrant = { ...unsigned, signature };
    this.approvals.set(grant.grantId, grant);
    this.write({ t: 'approval', grant });
    return grant;
  }

  consumeApproval(sessionId: string, toolName: string, argsDigest: string): boolean {
    const now = new Date().toISOString();
    for (const grant of [...this.approvals.values()].reverse()) {
      if (
        grant.sessionId !== sessionId ||
        grant.toolName !== toolName ||
        grant.remainingUses < 1 ||
        grant.expiresAt <= now
      )
        continue;
      if (grant.argsDigest && grant.argsDigest !== argsDigest) continue;
      const { signature: _oldSignature, ...unsigned } = grant;
      const consumed = this.signApproval({ ...unsigned, remainingUses: 0 });
      this.approvals.set(consumed.grantId, consumed);
      this.write({ t: 'approval', grant: consumed });
      return true;
    }
    return false;
  }

  listApprovals(sessionId?: string): ApprovalGrant[] {
    return [...this.approvals.values()]
      .filter((g) => !sessionId || g.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  verifyApproval(grant: ApprovalGrant): boolean {
    const { signature, ...unsigned } = grant;
    return (
      createHmac('sha256', this.actionKey).update(JSON.stringify(unsigned)).digest('hex') ===
      signature
    );
  }

  private signApproval(unsigned: Omit<ApprovalGrant, 'signature'>): ApprovalGrant {
    const signature = createHmac('sha256', this.actionKey)
      .update(JSON.stringify(unsigned))
      .digest('hex');
    return { ...unsigned, signature };
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

export interface ActionReceipt extends ActionReceiptInput {
  previousHash: string;
  hash: string;
}
export interface ApprovalGrant {
  grantId: string;
  sessionId: string;
  toolName: string;
  argsDigest?: string;
  createdAt: string;
  expiresAt: string;
  remainingUses: number;
  signature: string;
}

// ─── Trace types ────────────────────────────────────────────────────────────────
export interface TurnTrace {
  turnId: string;
  sessionId: string;
  channel: string;
  model?: string;
  modelTraceIds?: string[];
  recallQuery?: string;
  recallMemoryIds?: number[];
  recallArtifactIds?: number[];
  recallTokenCount?: number;
  toolCalls?: Array<{ name: string; stepType: string; ts: string }>;
  /** WS4: provider usage and priced cost for the winning attempt. */
  usage?: { promptTokens: number; completionTokens: number };
  usd?: number | null;
  userInput: string;
  reply: string;
  durationMs?: number;
  ts: string;
}
