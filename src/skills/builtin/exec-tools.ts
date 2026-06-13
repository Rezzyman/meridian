/**
 * run_code — bounded code execution.
 *
 * Every agent OS eventually needs to run a snippet (compute something, reshape
 * data, drive a quick script). The danger is obvious, so this tool is bounded
 * by construction rather than by good behavior:
 *
 *   - SECRET-SCRUBBED ENV. The child gets a minimal, hand-built environment —
 *     PATH, a throwaway HOME/TMPDIR, locale. It does NOT inherit process.env,
 *     so the agent's ROUTEXOR/ANTHROPIC/NEON/VOYAGE keys are invisible to
 *     executed code. A naive `child_process` that forwards process.env hands
 *     every secret to whatever it runs; this is the property that makes a code
 *     tool safe to expose to a model steered by an untrusted memory.
 *   - WALL-CLOCK CAP + GROUP KILL. A timeout SIGKILLs the whole process group
 *     (spawned detached), so a child that forks can't outlive the deadline.
 *   - OUTPUT CAP. stdout/stderr are capped so a runaway `print` loop can't pull
 *     megabytes back into the model context.
 *   - THROWAWAY WORKSPACE. cwd is a fresh temp dir, removed on completion.
 *
 * Honest about what it is NOT: this is process-level isolation, not a kernel
 * sandbox. It does NOT block network access or restrict the filesystem beyond
 * cwd. For untrusted code that needs true isolation, run Meridian's gateway
 * inside a container/VM. Accordingly `run_code` is a CLI-surface default only —
 * never exposed to a chat agent unless the operator opts in.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../toolkit.js';

const OUTPUT_CAP = 100_000; // bytes per stream returned to the model
const DEFAULT_TIMEOUT = 10_000;

const INTERPRETERS: Record<string, { cmd: string; ext: string }> = {
  python: { cmd: 'python3', ext: 'py' },
  node: { cmd: 'node', ext: 'js' },
  bash: { cmd: 'bash', ext: 'sh' },
  ruby: { cmd: 'ruby', ext: 'rb' },
};

interface CappedSink {
  push(chunk: Buffer): void;
  text(): string;
  truncated: boolean;
}

function cappedSink(): CappedSink {
  const bufs: Buffer[] = [];
  let len = 0;
  const sink: CappedSink = {
    truncated: false,
    push(chunk) {
      if (len >= OUTPUT_CAP) {
        sink.truncated = true;
        return;
      }
      const room = OUTPUT_CAP - len;
      if (chunk.length > room) {
        bufs.push(chunk.subarray(0, room));
        len = OUTPUT_CAP;
        sink.truncated = true;
      } else {
        bufs.push(chunk);
        len += chunk.length;
      }
    },
    text() {
      return Buffer.concat(bufs).toString('utf8');
    },
  };
  return sink;
}

/** Minimal environment: explicitly does NOT spread process.env, so the agent's
 *  API keys never reach executed code. */
function scrubbedEnv(workspace: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: workspace,
    TMPDIR: workspace,
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
}

const RunOut = z.union([
  z.object({
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    durationMs: z.number().int(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['interpreter_not_found', 'spawn_failed']),
    message: z.string(),
  }),
]);

export const execTools = {
  run_code: defineTool({
    description:
      'Run a short script (python/node/bash/ruby) with a wall-clock timeout, capped output, a ' +
      'throwaway working directory, and a SECRET-SCRUBBED environment (your API keys are NOT visible ' +
      'to the code). Returns exit code, stdout, stderr. Process-level isolation only — it does NOT ' +
      'block network access; do not run untrusted code outside a container.',
    parameters: z.object({
      language: z.enum(['python', 'node', 'bash', 'ruby']),
      code: z.string().min(1),
      stdin: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(60_000).default(DEFAULT_TIMEOUT),
    }),
    output: RunOut,
    execute: ({ language, code, stdin, timeoutMs }) => {
      const spec = INTERPRETERS[language];
      const workspace = mkdtempSync(join(tmpdir(), 'mexec-'));
      const scriptPath = join(workspace, `script.${spec.ext}`);
      try {
        writeFileSync(scriptPath, code);
      } catch (err) {
        rmSync(workspace, { recursive: true, force: true });
        return { ok: false as const, error: 'spawn_failed' as const, message: (err as Error).message };
      }

      const startedAt = Date.now();
      return new Promise<z.infer<typeof RunOut>>((resolve) => {
        let settled = false;
        const done = (r: z.infer<typeof RunOut>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rmSync(workspace, { recursive: true, force: true });
          resolve(r);
        };

        const child = spawn(spec.cmd, [scriptPath], {
          cwd: workspace,
          env: scrubbedEnv(workspace),
          detached: true, // own process group → we can kill any forks too
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const out = cappedSink();
        const err = cappedSink();
        let timedOut = false;

        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, timeoutMs ?? DEFAULT_TIMEOUT);

        child.stdout?.on('data', (d: Buffer) => out.push(d));
        child.stderr?.on('data', (d: Buffer) => err.push(d));

        child.on('error', (e: NodeJS.ErrnoException) => {
          done({
            ok: false as const,
            error: e.code === 'ENOENT' ? ('interpreter_not_found' as const) : ('spawn_failed' as const),
            message: e.code === 'ENOENT' ? `interpreter not installed: ${spec.cmd}` : e.message,
          });
        });

        child.on('close', (codeNum, signal) => {
          done({
            ok: codeNum === 0 && !timedOut,
            exitCode: codeNum,
            signal: signal ?? null,
            timedOut,
            stdout: out.text(),
            stderr: err.text(),
            truncated: out.truncated || err.truncated,
            durationMs: Date.now() - startedAt,
          });
        });

        if (stdin !== undefined) child.stdin?.write(stdin);
        child.stdin?.end();
      });
    },
  }),
};
