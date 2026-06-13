/**
 * File tools — the working set an agent needs to navigate a codebase or a
 * workspace: list a directory, glob for paths, grep file contents, and make a
 * scoped find/replace edit. `read`/`write` (core-tools) are the primitives;
 * these are the ergonomics on top.
 *
 * They sit at the same trust tier as `read`/`write`/`bash`: powerful, so they
 * default to the CLI surface only (never a chat agent unless the operator opts
 * in via config.tools.chat). Every walk is bounded — a node cap, a per-file
 * byte cap, skipped heavy directories — so a tool call can't wander the whole
 * disk or pull a 2 GB file back into the model.
 */

import { type Dirent, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../toolkit.js';

const MAX_NODES = 20_000; // directory entries visited per walk
const MAX_FILE_BYTES = 2_000_000; // skip/large-file guard for content search
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.turbo']);

/** Convert a glob (supporting `**`, `*`, `?`) to an anchored RegExp over a
 *  forward-slash relative path. `*` stops at a path separator; `**` spans them. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero directories
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Bounded recursive file walk. Yields POSIX-style relative paths from root.
 *  Skips SKIP_DIRS and stops after MAX_NODES entries (returns truncated). */
function walkFiles(root: string, includeHidden: boolean): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let visited = 0;
  const stack: string[] = [root];
  let truncated = false;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, don't abort the whole walk
    }
    for (const e of entries) {
      if (++visited > MAX_NODES) {
        truncated = true;
        break;
      }
      if (!includeHidden && e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        files.push(relative(root, full).split(sep).join('/'));
      }
    }
    if (truncated) break;
  }
  return { files, truncated };
}

const ListEntry = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir', 'other']),
  size: z.number().int(),
  mtimeMs: z.number(),
});

export const fileTools = {
  list_dir: defineTool({
    description:
      'List the immediate entries of a directory with type, size, and mtime. Hidden entries are ' +
      'omitted unless includeHidden is set.',
    parameters: z.object({
      path: z.string(),
      includeHidden: z.boolean().default(false),
    }),
    output: z.union([
      z.object({ ok: z.literal(true), entries: z.array(ListEntry) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    execute: ({ path, includeHidden }) => {
      let names: string[];
      try {
        names = readdirSync(path);
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
      const entries = [];
      for (const name of names) {
        if (!includeHidden && name.startsWith('.')) continue;
        try {
          const st = statSync(join(path, name));
          entries.push({
            name,
            type: st.isFile() ? ('file' as const) : st.isDirectory() ? ('dir' as const) : ('other' as const),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // a broken symlink, a race-deleted entry — list the name as 'other'
          entries.push({ name, type: 'other' as const, size: 0, mtimeMs: 0 });
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true as const, entries };
    },
  }),

  glob_files: defineTool({
    description:
      'Find files matching a glob (** spans directories, * within a segment, ? one char) under cwd. ' +
      'Skips node_modules/.git/dist and similar. Returns relative POSIX paths.',
    parameters: z.object({
      pattern: z.string(),
      cwd: z.string().default('.'),
      limit: z.number().int().min(1).max(5000).default(500),
      includeHidden: z.boolean().default(false),
    }),
    output: z.object({
      matches: z.array(z.string()),
      truncated: z.boolean(),
    }),
    execute: ({ pattern, cwd, limit, includeHidden }) => {
      const re = globToRegExp(pattern);
      const { files, truncated: walkTrunc } = walkFiles(cwd ?? '.', includeHidden ?? false);
      const matches = files.filter((f) => re.test(f)).sort();
      const capped = matches.slice(0, limit ?? 500);
      return { matches: capped, truncated: walkTrunc || capped.length < matches.length };
    },
  }),

  search_files: defineTool({
    description:
      'Search file contents under cwd for a query (literal substring, or a regex when isRegex is ' +
      'set), optionally restricted to files matching a glob. Returns file:line:text matches.',
    parameters: z.object({
      query: z.string().min(1),
      cwd: z.string().default('.'),
      glob: z.string().optional(),
      isRegex: z.boolean().default(false),
      ignoreCase: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(2000).default(200),
      includeHidden: z.boolean().default(false),
    }),
    output: z.union([
      z.object({
        ok: z.literal(true),
        matches: z.array(z.object({ file: z.string(), line: z.number().int(), text: z.string() })),
        truncated: z.boolean(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    execute: ({ query, cwd, glob, isRegex, ignoreCase, maxResults, includeHidden }) => {
      let matcher: RegExp;
      try {
        const flags = ignoreCase ? 'i' : '';
        matcher = isRegex
          ? new RegExp(query, flags)
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch (err) {
        return { ok: false as const, error: `invalid regex: ${(err as Error).message}` };
      }
      const fileFilter = glob ? globToRegExp(glob) : null;
      const { files, truncated: walkTrunc } = walkFiles(cwd ?? '.', includeHidden ?? false);
      const cap = maxResults ?? 200;
      const matches: Array<{ file: string; line: number; text: string }> = [];
      let truncated = walkTrunc;
      for (const f of files) {
        if (fileFilter && !fileFilter.test(f)) continue;
        let content: string;
        try {
          const full = join(cwd ?? '.', f);
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          content = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue; // skip binary
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher.test(lines[i])) {
            if (matches.length >= cap) {
              truncated = true;
              break;
            }
            matches.push({ file: f, line: i + 1, text: lines[i].slice(0, 500) });
          }
        }
        if (matches.length >= cap) break;
      }
      return { ok: true as const, matches, truncated };
    },
  }),

  edit_file: defineTool({
    description:
      'Find/replace within a single file — safer than overwriting via write. Replaces all matches ' +
      'by default (set all=false for the first only). Reports how many replacements were made; if ' +
      'find never matches, the file is untouched.',
    parameters: z.object({
      path: z.string(),
      find: z.string().min(1),
      replace: z.string(),
      all: z.boolean().default(true),
      isRegex: z.boolean().default(false),
    }),
    output: z.union([
      z.object({ ok: z.literal(true), replacements: z.number().int(), changed: z.boolean() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    execute: ({ path, find, replace, all, isRegex }) => {
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
      let pattern: RegExp;
      try {
        const body = isRegex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(body, all === false ? '' : 'g');
      } catch (err) {
        return { ok: false as const, error: `invalid regex: ${(err as Error).message}` };
      }
      let count = 0;
      const next = content.replace(pattern, () => {
        count++;
        return replace;
      });
      if (count === 0) return { ok: true as const, replacements: 0, changed: false };
      try {
        writeFileSync(path, next);
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
      return { ok: true as const, replacements: count, changed: true };
    },
  }),
};
