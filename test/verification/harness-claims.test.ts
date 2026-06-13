/**
 * Integrity guard for the harness-comparison evidence table. This is a
 * credibility artifact (docs/harness-comparison-methodology.md): it must stay
 * well-formed and honest. We do NOT assert anything about competitors here —
 * only that the data shape is valid, every cell is a legal value, and
 * MERIDIAN's own headline-bearing cells remain backed by in-repo evidence.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const CLAIMS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'mempoison',
  'harness-claims.json',
);
const VALUES = new Set(['yes', 'partial', 'no', 'unpublished']);

interface Catalog {
  dimensions: Array<{ key: string; label: string; question: string }>;
  harnesses: Array<{ name: string; summary: string; claims: Record<string, { value: string; evidence: string; source?: string }> }>;
}
const catalog: Catalog = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));

describe('harness-claims.json integrity', () => {
  it('every cell uses a legal value and carries evidence text', () => {
    for (const h of catalog.harnesses) {
      for (const d of catalog.dimensions) {
        const c = h.claims[d.key];
        assert.ok(c, `${h.name} missing dimension ${d.key}`);
        assert.ok(VALUES.has(c.value), `${h.name}.${d.key}: illegal value "${c.value}"`);
        assert.ok(c.evidence && c.evidence.length > 0, `${h.name}.${d.key}: empty evidence`);
      }
    }
  });

  it("a 'no' about a competitor must be cited (no uncited weakness claims)", () => {
    for (const h of catalog.harnesses) {
      if (h.name === 'MERIDIAN') continue;
      for (const d of catalog.dimensions) {
        const c = h.claims[d.key];
        if (c.value === 'no') {
          assert.ok(c.source, `${h.name}.${d.key}: a 'no' weakness claim must carry a source URL`);
        }
      }
    }
  });

  it('MERIDIAN headline cells stay backed by in-repo evidence', () => {
    const meridian = catalog.harnesses.find((h) => h.name === 'MERIDIAN');
    assert.ok(meridian, 'MERIDIAN must be in the table');
    // The dimensions the published headline depends on.
    for (const key of ['signed_provenance', 'multilingual', 'open_benchmark']) {
      assert.equal(meridian.claims[key]?.value, 'yes', `MERIDIAN.${key} must remain 'yes'`);
    }
  });
});
