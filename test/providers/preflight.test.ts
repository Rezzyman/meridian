import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderPosture } from '../../src/providers/preflight.js';

describe('provider posture preflight (defect h: routexor adapter aimed at a native endpoint)', () => {
  it('default ROUTEXOR endpoint is ok', () => {
    const p = checkProviderPosture('routexor/claude-haiku-4.5', {});
    assert.equal(p.ok, true);
    assert.equal(p.baseUrlHost, 'api.routexor.com');
  });
  it('a keyless proxy on a custom host is ok', () => {
    const p = checkProviderPosture('routexor/auto', {
      ROUTEXOR_BASE_URL: 'https://proxy.internal.example/v1',
    });
    assert.equal(p.ok, true);
  });
  it('refuses when the routexor base URL is a native provider endpoint (the 2026-08-18 outage)', () => {
    const p = checkProviderPosture('routexor/claude-sonnet-5', {
      ROUTEXOR_BASE_URL: 'https://api.anthropic.com/v1',
      ROUTEXOR_API_KEY: 'sk-ant-not-a-routexor-key',
    });
    assert.equal(p.ok, false);
    assert.match(p.reason ?? '', /api\.anthropic\.com/);
    assert.match(p.reason ?? '', /api\.routexor\.com/);
  });
  it('a malformed base URL is a clear failure, not a crash', () => {
    const p = checkProviderPosture('routexor/auto', { ROUTEXOR_BASE_URL: 'not a url' });
    assert.equal(p.ok, false);
  });
  it('non-routexor primaries are not judged by this check', () => {
    assert.equal(
      checkProviderPosture('anthropic/claude-sonnet-5', {
        ROUTEXOR_BASE_URL: 'https://api.anthropic.com',
      }).ok,
      true,
    );
  });
});
