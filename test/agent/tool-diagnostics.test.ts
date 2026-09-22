import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tool } from 'ai';
import { z } from 'zod';
import type { Logger } from 'pino';
import {
  classifyError,
  diagnoseToolSet,
  digestArgs,
  type ToolCallDiagnostic,
} from '../../src/agent/tool-diagnostics.js';

const quiet = { debug() {}, warn() {}, info() {}, error() {} } as unknown as Logger;

describe('tool diagnostics (defect g: tool failures had no structured record)', () => {
  it('records duration, outcome, and an args digest on success without touching the result', async () => {
    const seen: ToolCallDiagnostic[] = [];
    const tools = diagnoseToolSet(
      {
        echo: tool({
          description: 'echo',
          parameters: z.object({ v: z.string() }),
          execute: async ({ v }) => ({ v }),
        }),
      },
      { logger: quiet, onCall: (d) => seen.push(d) },
    );
    const exec = (
      tools.echo as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    ).execute;
    assert.deepEqual(await exec({ v: 'hi' }, {}), { v: 'hi' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.ok, true);
    assert.equal(seen[0]?.name, 'echo');
    assert.equal(seen[0]?.argsDigest, digestArgs({ v: 'hi' }));
    assert.equal(seen[0]?.argsDigest.length, 12);
  });

  it('classifies and rethrows failures unchanged', async () => {
    const seen: ToolCallDiagnostic[] = [];
    const tools = diagnoseToolSet(
      {
        flaky: tool({
          description: 'flaky',
          parameters: z.object({}),
          execute: async (): Promise<{ ok: boolean }> => {
            throw new Error('request timed out after 8000ms');
          },
        }),
      },
      { logger: quiet, onCall: (d) => seen.push(d) },
    );
    const exec = (
      tools.flaky as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    ).execute;
    await assert.rejects(() => exec({}, {}), /timed out/);
    assert.equal(seen[0]?.ok, false);
    assert.equal(seen[0]?.errorClass, 'timeout');
  });

  it('classifies common failure shapes', () => {
    assert.equal(classifyError(new Error('401 Unauthorized')), 'auth');
    assert.equal(classifyError(new Error('429 rate limit exceeded')), 'rate_limit');
    assert.equal(classifyError(new Error('fetch failed: ECONNREFUSED')), 'network');
    assert.equal(classifyError(new Error('google skill not configured')), 'not_configured');
    assert.equal(classifyError('nope'), 'non_error_throw');
  });

  it('never leaks arguments: the digest is not the payload', () => {
    const d = digestArgs({ password: 'hunter2' });
    assert.ok(!d.includes('hunter2'));
  });
});

describe('repeated identical tool-call quarantine (WS4 runaway brake)', () => {
  it('quarantines the same tool + same args past the limit and tells the model to stop', async () => {
    let executions = 0;
    const tools = diagnoseToolSet(
      {
        probe: tool({
          description: 'probe',
          parameters: z.object({ q: z.string() }),
          execute: async () => {
            executions += 1;
            return { ok: true };
          },
        }),
      },
      { logger: quiet, repeatLimit: 2 },
    );
    const exec = (
      tools.probe as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    ).execute;
    await exec({ q: 'same' }, {});
    await exec({ q: 'same' }, {});
    const third = (await exec({ q: 'same' }, {})) as { error?: string };
    assert.equal(executions, 2);
    assert.match(third.error ?? '', /Quarantined/);
    const different = (await exec({ q: 'other' }, {})) as { ok?: boolean };
    assert.equal(different.ok, true, 'different args are not quarantined');
  });
});
