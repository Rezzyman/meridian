/**
 * `meridian demo` — the launch-centerpiece proof must keep working. The demo's
 * central claim (100%→0% poisoning success, 0 false positives) is computed from
 * the live screen + catalog, and the whole flow must run with zero setup.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { demoBench, runDemo } from '../../src/cli/demo-cmd.js';

describe('meridian demo', () => {
  it('demoBench shows 100%→0% poisoning success with 0 false positives', () => {
    const b = demoBench();
    assert.ok(b.total >= 20, 'expected the full targeted vector set');
    assert.equal(b.off, b.total, 'every poison reaches the model with the defense OFF');
    assert.equal(b.on, 0, 'no poison reaches the model with the defense ON');
    assert.equal(b.fp, 0, 'no legitimate memory is wrongly quarantined');
  });

  it('runs end-to-end with zero setup (no model, no keys, no server)', async () => {
    process.env.MERIDIAN_DEMO_FAST = '1';
    const original = console.log;
    const out: string[] = [];
    console.log = (...args: unknown[]) => {
      out.push(args.join(' '));
    };
    try {
      await runDemo();
    } finally {
      console.log = original;
    }
    const text = out.join('\n');
    assert.match(text, /across the restart/, 'shows persistent memory');
    assert.match(text, /BLOCKED/, 'shows the poison quarantined');
    assert.match(text, /100% . 0%/, 'shows the benchmark headline');
  });
});
