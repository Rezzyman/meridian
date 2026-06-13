/**
 * File tools over a temp fixture tree: list_dir (hidden gating + sort),
 * glob_files (** vs * vs segment globs, skipped heavy dirs), search_files
 * (literal/regex/glob-filter/ignore-case, binary skip), and edit_file
 * (counted find/replace, no-op when nothing matches).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Tool } from 'ai';
import { fileTools, globToRegExp } from '../../src/skills/builtin/file-tools.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };
const list = fileTools.list_dir as Required<Tool>;
const glob = fileTools.glob_files as Required<Tool>;
const search = fileTools.search_files as Required<Tool>;
const edit = fileTools.edit_file as Required<Tool>;

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ft-'));
  writeFileSync(join(root, 'a.txt'), 'alpha needle here\nsecond line');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;');
  writeFileSync(join(root, '.hidden'), 'secret');
  writeFileSync(join(root, 'bin.dat'), Buffer.from('before \u0000 needle-in-binary', 'utf8'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'c.ts'), 'line one\nconst NEEDLE = 2;\nline three');
  writeFileSync(join(root, 'src', 'd.js'), 'module.exports = {};');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'skip.ts'), 'needle should be skipped');
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('list_dir', () => {
  it('lists entries sorted, hides dotfiles by default', async () => {
    const res = (await list.execute({ path: root }, TOOL_OPTS)) as {
      ok: boolean;
      entries: Array<{ name: string; type: string }>;
    };
    assert.equal(res.ok, true);
    const names = res.entries.map((e) => e.name);
    assert.deepEqual(names, ['a.txt', 'b.ts', 'bin.dat', 'node_modules', 'src']);
    assert.equal(res.entries.find((e) => e.name === 'src')?.type, 'dir');
  });

  it('includes dotfiles when asked', async () => {
    const res = (await list.execute({ path: root, includeHidden: true }, TOOL_OPTS)) as {
      entries: Array<{ name: string }>;
    };
    assert.ok(res.entries.some((e) => e.name === '.hidden'));
  });

  it('returns a structured error for a missing path', async () => {
    const res = (await list.execute({ path: join(root, 'nope') }, TOOL_OPTS)) as {
      ok: boolean;
      error: string;
    };
    assert.equal(res.ok, false);
    assert.match(res.error, /ENOENT|no such/i);
  });
});

describe('glob_files', () => {
  it('** spans directories and skips node_modules', async () => {
    const res = (await glob.execute({ pattern: '**/*.ts', cwd: root }, TOOL_OPTS)) as {
      matches: string[];
    };
    assert.deepEqual(res.matches, ['b.ts', 'src/c.ts']); // node_modules/skip.ts excluded
  });

  it('* stays within a path segment', async () => {
    const res = (await glob.execute({ pattern: '*.ts', cwd: root }, TOOL_OPTS)) as {
      matches: string[];
    };
    assert.deepEqual(res.matches, ['b.ts']); // not src/c.ts
  });

  it('matches a segment glob', async () => {
    const res = (await glob.execute({ pattern: 'src/*.js', cwd: root }, TOOL_OPTS)) as {
      matches: string[];
    };
    assert.deepEqual(res.matches, ['src/d.js']);
  });
});

describe('search_files', () => {
  it('finds literal matches as file:line:text, skipping binary and node_modules', async () => {
    const res = (await search.execute({ query: 'needle', cwd: root }, TOOL_OPTS)) as {
      ok: boolean;
      matches: Array<{ file: string; line: number }>;
    };
    assert.equal(res.ok, true);
    const files = res.matches.map((m) => `${m.file}:${m.line}`);
    assert.deepEqual(files, ['a.txt:1']); // bin.dat (NUL) and node_modules excluded; case-sensitive
  });

  it('honors ignoreCase', async () => {
    const res = (await search.execute(
      { query: 'needle', cwd: root, ignoreCase: true },
      TOOL_OPTS,
    )) as { matches: Array<{ file: string; line: number }> };
    const files = res.matches.map((m) => `${m.file}:${m.line}`).sort();
    assert.deepEqual(files, ['a.txt:1', 'src/c.ts:2']); // NEEDLE in c.ts now matches
  });

  it('restricts to a file glob and supports regex', async () => {
    const res = (await search.execute(
      { query: 'NEEDLE|needle', cwd: root, isRegex: true, glob: '**/*.ts' },
      TOOL_OPTS,
    )) as { matches: Array<{ file: string }> };
    assert.deepEqual(
      res.matches.map((m) => m.file),
      ['src/c.ts'],
    );
  });

  it('reports an invalid regex as data, not a throw', async () => {
    const res = (await search.execute(
      { query: '(', cwd: root, isRegex: true },
      TOOL_OPTS,
    )) as { ok: boolean; error: string };
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid regex/);
  });
});

describe('edit_file', () => {
  it('replaces all matches and reports the count', async () => {
    const f = join(root, 'edit.txt');
    writeFileSync(f, 'foo foo foo');
    const res = (await edit.execute({ path: f, find: 'foo', replace: 'bar' }, TOOL_OPTS)) as {
      ok: boolean;
      replacements: number;
      changed: boolean;
    };
    assert.equal(res.ok, true);
    assert.equal(res.replacements, 3);
    assert.equal(res.changed, true);
    assert.equal(readFileSync(f, 'utf8'), 'bar bar bar');
  });

  it('all=false replaces only the first', async () => {
    const f = join(root, 'edit2.txt');
    writeFileSync(f, 'x x x');
    const res = (await edit.execute(
      { path: f, find: 'x', replace: 'y', all: false },
      TOOL_OPTS,
    )) as { replacements: number };
    assert.equal(res.replacements, 1);
    assert.equal(readFileSync(f, 'utf8'), 'y x x');
  });

  it('leaves the file untouched when nothing matches', async () => {
    const f = join(root, 'edit3.txt');
    writeFileSync(f, 'hello');
    const res = (await edit.execute({ path: f, find: 'zzz', replace: 'q' }, TOOL_OPTS)) as {
      replacements: number;
      changed: boolean;
    };
    assert.equal(res.replacements, 0);
    assert.equal(res.changed, false);
    assert.equal(readFileSync(f, 'utf8'), 'hello');
  });

  it('treats find as a literal by default (regex metachars are escaped)', async () => {
    const f = join(root, 'edit4.txt');
    writeFileSync(f, 'a.b a.b');
    const res = (await edit.execute({ path: f, find: 'a.b', replace: 'Z' }, TOOL_OPTS)) as {
      replacements: number;
    };
    assert.equal(res.replacements, 2);
    assert.equal(readFileSync(f, 'utf8'), 'Z Z'); // '.' did not act as a wildcard
  });
});

describe('globToRegExp', () => {
  it('maps glob syntax to anchored regexes', () => {
    assert.ok(globToRegExp('*.ts').test('a.ts'));
    assert.ok(!globToRegExp('*.ts').test('a/b.ts'));
    assert.ok(globToRegExp('**/*.ts').test('a/b/c.ts'));
    assert.ok(globToRegExp('src/?.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/?.ts').test('src/ab.ts'));
  });
});
