/**
 * sqlite-lite — READ-ONLY SQLite table reader for `meridian import`.
 *
 * Hermes keeps its durable state (session index, messages, memory tables) in
 * `state.db`; the importer needs to read it without adding a native
 * dependency. Two backends:
 *
 *   1. `node:sqlite` (Node 22.13+/23+) — loaded lazily via createRequire so
 *      importing a home WITHOUT a state.db never touches sqlite at all, and
 *      Node 20 (the engines floor) doesn't crash on a missing builtin.
 *   2. A pure-JS fallback that walks the file format directly (header, table
 *      b-trees, record serial types, overflow chains). It reads the main file
 *      only — an unmerged `-wal` sidecar is reported via `walPossiblyStale`
 *      so the caller can warn instead of silently missing recent writes.
 *
 * Reads only. Neither backend ever opens the file for writing.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

export type SqliteCell = string | number | bigint | Uint8Array | null;

export interface SqliteTableDump {
  name: string;
  columns: string[];
  rows: SqliteCell[][];
  truncated: boolean;
}

export interface SqliteReader {
  backend: 'node:sqlite' | 'pure';
  /** User table names (sqlite_* internals excluded). */
  tables: string[];
  /** True when the pure backend sees a non-empty -wal sidecar it cannot merge. */
  walPossiblyStale: boolean;
  read(table: string, limit: number): SqliteTableDump;
  close(): void;
}

/** Set MERIDIAN_SQLITE_PURE=1 to force the pure reader (test hook + escape hatch). */
export function openSqliteReadOnly(path: string): SqliteReader {
  if (process.env.MERIDIAN_SQLITE_PURE !== '1') {
    try {
      return openNative(path);
    } catch {
      // node:sqlite missing (Node < 22.13) or refused the file — fall through.
    }
  }
  return openPure(path);
}

// ─── Backend 1: node:sqlite ────────────────────────────────────────────────────

interface NativeStatement {
  all(): Record<string, SqliteCell>[];
}
interface NativeDatabase {
  prepare(sql: string): NativeStatement;
  close(): void;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function openNative(path: string): SqliteReader {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string, opts: { readOnly: boolean }) => NativeDatabase;
  };
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => String(r.name));
  return {
    backend: 'node:sqlite',
    tables,
    walPossiblyStale: false,
    read(table, limit) {
      if (!tables.includes(table)) throw new Error(`no such table: ${table}`);
      const columns = db
        .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
        .all()
        .map((r) => String(r.name));
      const raw = db.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ${limit + 1}`).all();
      const truncated = raw.length > limit;
      const rows = raw.slice(0, limit).map((r) => columns.map((c) => r[c] ?? null));
      return { name: table, columns, rows, truncated };
    },
    close() {
      db.close();
    },
  };
}

// ─── Backend 2: pure-JS file-format walk ───────────────────────────────────────

interface PureTable {
  name: string;
  rootPage: number;
  columns: string[];
  /** index of the INTEGER PRIMARY KEY column (rowid alias), or -1. */
  ipk: number;
  withoutRowid: boolean;
}

function readVarint(buf: Buffer, off: number): [value: number, next: number] {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    const byte = buf[off + i];
    result = result * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [result, off + i + 1];
  }
  // 9th byte contributes all 8 bits.
  return [result * 256 + buf[off + 8], off + 9];
}

function signExtend(buf: Buffer, off: number, bytes: number): number {
  let v = BigInt(buf[off] & 0x7f) - BigInt(buf[off] & 0x80);
  for (let i = 1; i < bytes; i++) v = (v << 8n) | BigInt(buf[off + i]);
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : n; // beyond 2^53 loses precision; fine for a dump
}

/** Column names (and the rowid-alias index) from a CREATE TABLE statement. */
export function parseCreateTableColumns(sql: string): { columns: string[]; ipk: number } {
  const open = sql.indexOf('(');
  if (open < 0) return { columns: [], ipk: -1 };
  // Slice to the MATCHING close paren, tracking depth and quotes.
  let depth = 0;
  let end = sql.length;
  let quote: string | null = null;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = sql.slice(open + 1, end);
  const parts: string[] = [];
  let start = 0;
  depth = 0;
  quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  const CONSTRAINT = /^(primary|unique|check|foreign|constraint)\b/i;
  const columns: string[] = [];
  let ipk = -1;
  for (const part of parts) {
    const def = part.trim();
    if (!def || CONSTRAINT.test(def)) continue;
    let name: string;
    const quoted = def.match(/^(["'`[])/);
    if (quoted) {
      const q = quoted[1] === '[' ? ']' : quoted[1];
      name = def.slice(1, def.indexOf(q, 1));
    } else {
      name = def.split(/\s/)[0];
    }
    if (/^integer\s+primary\s+key/i.test(def.slice(name.length + (quoted ? 2 : 0)).trim())) {
      ipk = columns.length;
    }
    columns.push(name);
  }
  return { columns, ipk };
}

function openPure(path: string): SqliteReader {
  const buf = readFileSync(path);
  if (buf.length < 100 || buf.toString('latin1', 0, 15) !== 'SQLite format 3' || buf[15] !== 0) {
    throw new Error('not a SQLite 3 database');
  }
  const rawPageSize = buf.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  const usable = pageSize - buf[20];
  if (buf.readUInt32BE(56) !== 1) throw new Error('only UTF-8 databases supported');

  const walPath = `${path}-wal`;
  const walPossiblyStale =
    existsSync(walPath) &&
    (() => {
      try {
        return statSync(walPath).size > 32; // header-only WAL carries no frames
      } catch {
        return false;
      }
    })();

  const decodeRecord = (payload: Buffer): SqliteCell[] => {
    const [headerSize, afterHeader] = readVarint(payload, 0);
    const types: number[] = [];
    let p = afterHeader;
    while (p < headerSize) {
      const [t, next] = readVarint(payload, p);
      types.push(t);
      p = next;
    }
    const values: SqliteCell[] = [];
    let d = headerSize;
    for (const t of types) {
      if (t === 0) values.push(null);
      else if (t >= 1 && t <= 6) {
        const bytes = [0, 1, 2, 3, 4, 6, 8][t];
        values.push(signExtend(payload, d, bytes));
        d += bytes;
      } else if (t === 7) {
        values.push(payload.readDoubleBE(d));
        d += 8;
      } else if (t === 8) values.push(0);
      else if (t === 9) values.push(1);
      else {
        const len = (t - (t % 2 === 0 ? 12 : 13)) / 2;
        values.push(
          t % 2 === 0
            ? new Uint8Array(payload.subarray(d, d + len))
            : payload.toString('utf8', d, d + len),
        );
        d += len;
      }
    }
    return values;
  };

  /** Assemble a cell payload, following the overflow chain when present. */
  const readPayload = (off: number, total: number): Buffer => {
    const X = usable - 35;
    if (total <= X) return buf.subarray(off, off + total);
    const M = Math.floor(((usable - 12) * 32) / 255) - 23;
    const K = M + ((total - M) % (usable - 4));
    const local = K <= X ? K : M;
    const parts = [buf.subarray(off, off + local)];
    let next = buf.readUInt32BE(off + local);
    let remaining = total - local;
    while (next !== 0 && remaining > 0) {
      const base = (next - 1) * pageSize;
      next = buf.readUInt32BE(base);
      const take = Math.min(usable - 4, remaining);
      parts.push(buf.subarray(base + 4, base + 4 + take));
      remaining -= take;
    }
    return Buffer.concat(parts);
  };

  const walkTable = (page: number, onRow: (rowid: number, payload: Buffer) => boolean): boolean => {
    const base = (page - 1) * pageSize;
    const hdr = base + (page === 1 ? 100 : 0);
    const type = buf[hdr];
    const nCells = buf.readUInt16BE(hdr + 3);
    const ptrArray = hdr + (type === 5 ? 12 : 8);
    if (type === 5) {
      for (let i = 0; i < nCells; i++) {
        const cell = base + buf.readUInt16BE(ptrArray + 2 * i);
        if (!walkTable(buf.readUInt32BE(cell), onRow)) return false;
      }
      return walkTable(buf.readUInt32BE(hdr + 8), onRow);
    }
    if (type !== 13) throw new Error(`unsupported b-tree page type ${type}`);
    for (let i = 0; i < nCells; i++) {
      let cell = base + buf.readUInt16BE(ptrArray + 2 * i);
      const [payloadLen, afterLen] = readVarint(buf, cell);
      const [rowid, afterRowid] = readVarint(buf, afterLen);
      cell = afterRowid;
      if (!onRow(rowid, readPayload(cell, payloadLen))) return false;
    }
    return true;
  };

  // sqlite_master lives at page 1: columns (type, name, tbl_name, rootpage, sql).
  const tables: PureTable[] = [];
  walkTable(1, (_rowid, payload) => {
    const [type, name, , rootpage, sql] = decodeRecord(payload);
    if (type === 'table' && typeof name === 'string' && !name.startsWith('sqlite_')) {
      const src = typeof sql === 'string' ? sql : '';
      const { columns, ipk } = parseCreateTableColumns(src);
      tables.push({
        name,
        rootPage: typeof rootpage === 'number' ? rootpage : 0,
        columns,
        ipk,
        withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(src),
      });
    }
    return true;
  });

  return {
    backend: 'pure',
    tables: tables.map((t) => t.name),
    walPossiblyStale,
    read(table, limit) {
      const t = tables.find((x) => x.name === table);
      if (!t) throw new Error(`no such table: ${table}`);
      // rootPage 0 = virtual table (fts5 etc.); WITHOUT ROWID uses index
      // b-trees this walker does not speak.
      if (t.rootPage === 0 || t.withoutRowid) {
        throw new Error(`table ${table} is virtual or WITHOUT ROWID (unsupported)`);
      }
      const rows: SqliteCell[][] = [];
      let truncated = false;
      walkTable(t.rootPage, (rowid, payload) => {
        if (rows.length >= limit) {
          truncated = true;
          return false;
        }
        const values = decodeRecord(payload);
        // An INTEGER PRIMARY KEY column stores NULL; its value is the rowid.
        if (t.ipk >= 0 && values[t.ipk] === null) values[t.ipk] = rowid;
        while (values.length < t.columns.length) values.push(null);
        rows.push(values.slice(0, t.columns.length));
        return true;
      });
      return { name: table, columns: t.columns, rows, truncated };
    },
    close() {
      // nothing held open — the file was read into memory
    },
  };
}
