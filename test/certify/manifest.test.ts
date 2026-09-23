import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CapabilityManifestSchema,
  loadManifest,
  missingRequired,
  requiredCapabilityIds,
} from '../../src/certify/manifest.js';

describe('capability manifest (certification step 1)', () => {
  it("Arlo's draft manifest parses and carries every required probe", () => {
    const m = loadManifest(join(process.cwd(), 'examples/arlo/CAPABILITIES/manifest.yaml'));
    assert.equal(m.agent, 'arlo');
    assert.deepEqual(missingRequired(m), []);
    assert.ok(m.capabilities.length >= 15);
    assert.ok(m.capabilities.every((c) => c.claim.length > 0));
  });
  it('rejects a manifest with a duplicate id or an unknown probe kind', () => {
    assert.throws(() =>
      CapabilityManifestSchema.parse({
        schema: 'meridian.capabilities.v1',
        agent: 'x',
        audience: 'internal',
        capabilities: [{ id: 'a', claim: 'c', probe: { kind: 'telepathy' } }],
      }),
    );
  });
  it('client-facing agents must promise brand and stranger-refusal probes', () => {
    const ids = requiredCapabilityIds('client-facing');
    assert.ok(ids.includes('brand.no-internal-names'));
    assert.ok(ids.includes('privacy.stranger-refusal'));
    assert.ok(!requiredCapabilityIds('internal').includes('brand.no-internal-names'));
  });
});
