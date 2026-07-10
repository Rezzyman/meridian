/**
 * vision + pdf config blocks: defaults land without any YAML, operator
 * overrides parse, and defaultAgentConfig stays schema-valid.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentConfigSchema,
  defaultAgentConfig,
  PdfConfigSchema,
  VisionConfigSchema,
} from '../../src/config/schema.js';
import { makeConfig } from '../helpers/fixtures.js';

describe('vision config', () => {
  it('defaults: enabled, 25 MB cap, 120s timeout, no pinned model/prompt', () => {
    const v = VisionConfigSchema.parse({});
    assert.equal(v.enabled, true);
    assert.equal(v.maxBytes, 25 * 1024 * 1024);
    assert.equal(v.timeoutSeconds, 120);
    assert.equal(v.model, undefined);
    assert.equal(v.prompt, undefined);
  });

  it('a config.yaml without a vision block still gets the full block', () => {
    const cfg = makeConfig();
    assert.equal(cfg.vision.enabled, true);
    assert.equal(cfg.vision.maxBytes, 25 * 1024 * 1024);
    assert.equal(cfg.vision.timeoutSeconds, 120);
  });

  it('accepts an operator-custom model + prompt (the Stormy shape)', () => {
    const cfg = makeConfig({
      vision: {
        model: 'anthropic/claude-sonnet-4.6',
        prompt: 'You are a roofing damage assessor. Grade hail and wind damage per slope.',
        maxBytes: 10 * 1024 * 1024,
        timeoutSeconds: 60,
      },
    });
    assert.equal(cfg.vision.model, 'anthropic/claude-sonnet-4.6');
    assert.ok(cfg.vision.prompt?.includes('roofing damage assessor'));
    assert.equal(cfg.vision.maxBytes, 10 * 1024 * 1024);
    assert.equal(cfg.vision.timeoutSeconds, 60);
  });
});

describe('pdf config', () => {
  it('defaults to OpenClaw parity: 50 pages / 32 MB, no pinned model', () => {
    const p = PdfConfigSchema.parse({});
    assert.equal(p.maxPages, 50);
    assert.equal(p.maxBytesMb, 32);
    assert.equal(p.model, undefined);
  });

  it('a config.yaml without a pdf block still gets the caps', () => {
    const cfg = makeConfig();
    assert.equal(cfg.pdf.maxPages, 50);
    assert.equal(cfg.pdf.maxBytesMb, 32);
  });

  it('accepts operator overrides', () => {
    const cfg = makeConfig({ pdf: { maxPages: 10, maxBytesMb: 8, model: 'openai/gpt-4o-mini' } });
    assert.equal(cfg.pdf.maxPages, 10);
    assert.equal(cfg.pdf.maxBytesMb, 8);
    assert.equal(cfg.pdf.model, 'openai/gpt-4o-mini');
  });

  it('rejects nonsense caps', () => {
    assert.throws(() => PdfConfigSchema.parse({ maxPages: 0 }));
    assert.throws(() => PdfConfigSchema.parse({ maxBytesMb: -1 }));
  });
});

describe('defaultAgentConfig', () => {
  it('includes vision + pdf and round-trips through the schema', () => {
    const cfg = AgentConfigSchema.parse(defaultAgentConfig('t', 'T'));
    assert.equal(cfg.vision.enabled, true);
    assert.equal(cfg.pdf.maxPages, 50);
    assert.equal(cfg.pdf.maxBytesMb, 32);
  });
});
