/**
 * sqlite-lite — the zero-dep read-only SQLite reader behind hermes state.db
 * extraction. The committed fixture (test/fixtures/hermes-state.db) is a real
 * sqlite file with an INTEGER PRIMARY KEY rowid alias, a TEXT primary key, and
 * a row long enough to exercise the overflow-page chain. The pure backend must
 * agree byte-for-byte with node:sqlite wherever the builtin exists.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openSqliteReadOnly, parseCreateTableColumns } from '../../src/cli/sqlite-lite.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'hermes-state.db');

function hasNodeSqlite(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return !!(process.getBuiltinModule?.('node:sqlite') ?? false);
  } catch {
    return false;
  }
}

describe('sqlite-lite', () => {
  let prevPure: string | undefined;
  beforeEach(() => {
    prevPure = process.env.MERIDIAN_SQLITE_PURE;
  });
  afterEach(() => {
    if (prevPure === undefined) delete process.env.MERIDIAN_SQLITE_PURE;
    else process.env.MERIDIAN_SQLITE_PURE = prevPure;
  });

  it('pure backend reads tables, rowid aliases, and overflow-length rows', () => {
    process.env.MERIDIAN_SQLITE_PURE = '1';
    const db = openSqliteReadOnly(FIXTURE);
    try {
      assert.equal(db.backend, 'pure');
      assert.ok(db.tables.includes('memories') && db.tables.includes('sessions'));
      assert.equal(db.walPossiblyStale, false, 'checkpointed fixture carries no WAL');
      const mem = db.read('memories', 500);
      assert.deepEqual(mem.columns, ['id', 'content', 'category', 'created_at']);
      assert.equal(mem.rows.length, 3);
      assert.equal(mem.rows[0][0], 1, 'INTEGER PRIMARY KEY backfilled from the rowid');
      assert.match(String(mem.rows[0][1]), /flat whites/);
      const long = String(mem.rows[2][1]);
      assert.ok(long.startsWith('LONGMEMSTART') && long.endsWith('LONGMEMEND'), 'overflow chain reassembled');
      assert.ok(long.length > 4096, 'row really spans pages');
      const ses = db.read('sessions', 500);
      assert.equal(ses.rows.length, 3);
      assert.equal(ses.rows[0][0], 'telegram_777_20260501', 'TEXT primary key read');
      assert.equal(ses.rows[0][5], 12, 'integer column read');
      assert.equal(ses.rows[0][4], 1777000000.5, 'float column read');
      assert.throws(() => db.read('nope', 10), /no such table/);
    } finally {
      db.close();
    }
  });

  it('truncates at the row limit and reports it', () => {
    process.env.MERIDIAN_SQLITE_PURE = '1';
    const db = openSqliteReadOnly(FIXTURE);
    try {
      const mem = db.read('memories', 2);
      assert.equal(mem.rows.length, 2);
      assert.equal(mem.truncated, true);
    } finally {
      db.close();
    }
  });

  it('pure and node:sqlite backends agree on every cell (when the builtin exists)', (t) => {
    if (!hasNodeSqlite()) {
      t.skip('node:sqlite not available on this Node');
      return;
    }
    process.env.MERIDIAN_SQLITE_PURE = '1';
    const pure = openSqliteReadOnly(FIXTURE);
    delete process.env.MERIDIAN_SQLITE_PURE;
    const native = openSqliteReadOnly(FIXTURE);
    try {
      assert.equal(native.backend, 'node:sqlite');
      assert.deepEqual([...pure.tables].sort(), [...native.tables].sort());
      for (const table of ['memories', 'sessions', 'messages', 'schema_version']) {
        const a = pure.read(table, 1000);
        const b = native.read(table, 1000);
        assert.deepEqual(a.columns, b.columns, `${table} columns agree`);
        assert.deepEqual(a.rows, b.rows, `${table} rows agree`);
      }
    } finally {
      pure.close();
      native.close();
    }
  });

  it('rejects files that are not sqlite', () => {
    process.env.MERIDIAN_SQLITE_PURE = '1';
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-lite-'));
    try {
      const bogus = join(dir, 'state.db');
      writeFileSync(bogus, 'definitely not a database');
      assert.throws(() => openSqliteReadOnly(bogus), /not a SQLite 3 database/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseCreateTableColumns handles quoting, constraints, and the rowid alias', () => {
    const { columns, ipk } = parseCreateTableColumns(
      'CREATE TABLE t ("id" INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, meta TEXT CHECK (length(meta) < 10), PRIMARY KEY (name), FOREIGN KEY (name) REFERENCES x(y))',
    );
    assert.deepEqual(columns, ['id', 'name', 'meta']);
    assert.equal(ipk, 0);
  });
});
