/**
 * Core built-in tools: bash, read, write, edit, web_fetch.
 * Use cautiously; agents call these directly.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tool } from 'ai';
import { z } from 'zod';

export const coreTools = {
  bash: tool({
    description: 'Execute a shell command in the agent workspace. Use for read-only inspection by default.',
    parameters: z.object({
      command: z.string(),
      timeoutMs: z.number().int().default(30000),
    }),
    execute: async ({ command, timeoutMs }) => {
      try {
        const out = execSync(command, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }).toString();
        return { ok: true, stdout: out };
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number; message: string };
        return {
          ok: false,
          status: e.status ?? -1,
          stdout: e.stdout?.toString() ?? '',
          stderr: e.stderr?.toString() ?? e.message,
        };
      }
    },
  }),
  read: tool({
    description: 'Read a file from disk. Returns full contents as text.',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      if (!existsSync(path)) return { ok: false, error: 'not found' };
      return { ok: true, content: readFileSync(path, 'utf8') };
    },
  }),
  write: tool({
    description: 'Write content to a file (overwrites). Path must already be absolute or relative to cwd.',
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      writeFileSync(path, content);
      return { ok: true, bytes: Buffer.byteLength(content) };
    },
  }),
  web_fetch: tool({
    description: 'Fetch a URL and return its text body.',
    parameters: z.object({ url: z.string().url(), timeoutMs: z.number().int().default(15000) }),
    execute: async ({ url, timeoutMs }) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body: body.slice(0, 200_000) };
    },
  }),
};
