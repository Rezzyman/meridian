/**
 * run_code — bounded execution. The load-bearing test is SECRET SCRUBBING: a
 * secret in the parent's process.env must NOT be visible to executed code.
 * Plus: exit codes, stderr, the wall-clock timeout actually kills the process,
 * the output cap truncates, stdin is plumbed, and a second interpreter works.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Tool } from 'ai';
import { execTools } from '../../src/skills/builtin/exec-tools.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };
const run = execTools.run_code as Required<Tool>;

type Result = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};

describe('run_code — bounded execution', () => {
  it('runs node and returns stdout + a clean exit', async () => {
    const r = (await run.execute(
      { language: 'node', code: 'console.log(40 + 2)', timeoutMs: 8000 },
      TOOL_OPTS,
    )) as Result;
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '42');
    assert.equal(r.timedOut, false);
  });

  it('SCRUBS secrets — process.env keys are invisible to executed code', async () => {
    const prev = process.env.MERIDIAN_TEST_SECRET;
    process.env.MERIDIAN_TEST_SECRET = 'super-secret-key';
    try {
      const r = (await run.execute(
        {
          language: 'node',
          code: 'console.log(process.env.MERIDIAN_TEST_SECRET || "absent")',
          timeoutMs: 8000,
        },
        TOOL_OPTS,
      )) as Result;
      assert.equal(r.stdout.trim(), 'absent', 'the secret leaked into the child env');
    } finally {
      if (prev === undefined) delete process.env.MERIDIAN_TEST_SECRET;
      else process.env.MERIDIAN_TEST_SECRET = prev;
    }
  });

  it('surfaces a non-zero exit code as ok:false', async () => {
    const r = (await run.execute(
      { language: 'node', code: 'process.exit(3)', timeoutMs: 8000 },
      TOOL_OPTS,
    )) as Result;
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 3);
  });

  it('captures stderr', async () => {
    const r = (await run.execute(
      { language: 'node', code: 'console.error("boom"); process.exit(1)', timeoutMs: 8000 },
      TOOL_OPTS,
    )) as Result;
    assert.match(r.stderr, /boom/);
    assert.equal(r.exitCode, 1);
  });

  it('enforces the wall-clock timeout and kills the process', async () => {
    const r = (await run.execute(
      { language: 'node', code: 'setTimeout(() => {}, 100000)', timeoutMs: 400 },
      TOOL_OPTS,
    )) as Result;
    assert.equal(r.timedOut, true);
    assert.equal(r.ok, false);
    assert.ok(r.durationMs < 5000, 'should resolve promptly after the kill');
  });

  it('caps oversize output and flags truncation', async () => {
    const r = (await run.execute(
      { language: 'node', code: 'process.stdout.write("x".repeat(200000))', timeoutMs: 8000 },
      TOOL_OPTS,
    )) as Result;
    assert.equal(r.truncated, true);
    assert.equal(r.stdout.length, 100_000);
  });

  it('plumbs stdin', async () => {
    const r = (await run.execute(
      {
        language: 'node',
        code: 'process.stdin.on("data", (d) => process.stdout.write(d))',
        stdin: 'echoed',
        timeoutMs: 8000,
      },
      TOOL_OPTS,
    )) as Result;
    assert.equal(r.stdout.trim(), 'echoed');
  });

  it('works across interpreters (bash)', async () => {
    const r = (await run.execute(
      { language: 'bash', code: 'echo hello from bash', timeoutMs: 8000 },
      TOOL_OPTS,
    )) as Result;
    assert.equal(r.ok, true);
    assert.equal(r.stdout.trim(), 'hello from bash');
  });
});
