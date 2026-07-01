/**
 * First-run defaults. `meridian init <slug>` with no flags must produce a
 * zero-config (embedded) agent so `install → talking agent` is literally true;
 * the CORTEX-server path is chosen only on explicit request or when creds are
 * already present. These are pure-decision tests over resolveEmbedded.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveEmbedded } from '../../src/cli/init-cmd.js';

const NO_CREDS: NodeJS.ProcessEnv = {};
const WITH_CREDS: NodeJS.ProcessEnv = {
  NEON_DATABASE_URL: 'postgres://x',
  VOYAGE_API_KEY: 'vk-x',
};

describe('resolveEmbedded — embedded is the default', () => {
  it('bare init with no creds → embedded (the make-or-break keyless path)', () => {
    assert.equal(resolveEmbedded({}, NO_CREDS), true);
  });

  it('--cortex forces the server path', () => {
    assert.equal(resolveEmbedded({ cortex: true }, NO_CREDS), false);
  });

  it('--embedded forces embedded even when CORTEX creds are present', () => {
    assert.equal(resolveEmbedded({ embedded: true }, WITH_CREDS), true);
  });

  it('existing NEON + VOYAGE creds default to the server path', () => {
    assert.equal(resolveEmbedded({}, WITH_CREDS), false);
  });

  it('--embedded beats --cortex when both are somehow passed', () => {
    assert.equal(resolveEmbedded({ embedded: true, cortex: true }, WITH_CREDS), true);
  });

  it('partial creds (only NEON) still defaults to embedded', () => {
    assert.equal(resolveEmbedded({}, { NEON_DATABASE_URL: 'postgres://x' }), true);
  });
});
