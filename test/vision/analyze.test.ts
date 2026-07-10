/**
 * analyzeImage() unit tests: multimodal message assembly, chain resolution
 * (pinned model first, vision-capable filter, missing-key skip), provider
 * fallback with breaker reporting, size caps, and the error firewall (raw
 * provider errors never surface). All models are MockLanguageModelV1.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LanguageModelV1 } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { VisionConfigSchema } from '../../src/config/schema.js';
import type { ProviderRouter } from '../../src/providers/router.js';
import {
  analyzeImage,
  isVisionCapableRef,
  VisionAnalysisError,
  visionChain,
} from '../../src/vision/analyze.js';
import { makeConfig, silentLogger } from '../helpers/fixtures.js';

type GenerateOptions = Parameters<LanguageModelV1['doGenerate']>[0];

const MODELS = makeConfig().models; // routexor/claude-4-haiku + [routexor/claude-sonnet-4.6, ollama/qwen2.5]

function vision(overrides: Record<string, unknown> = {}) {
  return VisionConfigSchema.parse(overrides);
}

/** Model that answers `text` and records every doGenerate call's options. */
function answeringModel(text: string): { model: MockLanguageModelV1; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = [];
  const model = new MockLanguageModelV1({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        text,
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 10 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, calls };
}

function throwingModel(message: string): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

/** Router stub keyed by ref. Records breaker reports; unknown refs throw
 *  (missing provider key), mirroring ProviderRouter.resolve. */
function refRouter(map: Record<string, LanguageModelV1>) {
  const failures: string[] = [];
  const successes: string[] = [];
  const open = new Set<string>();
  const router = {
    resolve(ref: string) {
      const model = map[ref];
      if (!model) throw new Error(`no key for ${ref}`);
      const slash = ref.indexOf('/');
      return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1), ref, model };
    },
    isOpen: (ref: string) => open.has(ref),
    reportFailure: (ref: string) => failures.push(ref),
    reportSuccess: (ref: string) => successes.push(ref),
  } as unknown as ProviderRouter;
  return { router, failures, successes, open };
}

function tmpImage(bytes = 64): string {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-vision-'));
  const p = join(dir, 'photo.png');
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

describe('isVisionCapableRef', () => {
  it('accepts anthropic/openai across the board and claude/gpt on routexor', () => {
    assert.equal(isVisionCapableRef('anthropic/claude-sonnet-4.6'), true);
    assert.equal(isVisionCapableRef('openai/gpt-4o-mini'), true);
    assert.equal(isVisionCapableRef('routexor/claude-4-haiku'), true);
  });
  it('rejects text-only local/groq models but accepts multimodal families', () => {
    assert.equal(isVisionCapableRef('ollama/qwen2.5'), false);
    assert.equal(isVisionCapableRef('groq/llama-4-scout'), true);
    assert.equal(isVisionCapableRef('ollama/llava'), true);
  });
});

describe('visionChain', () => {
  it('pins vision.model first, then vision-capable chain members', () => {
    const { router } = refRouter({
      'anthropic/claude-opus': answeringModel('x').model,
      'routexor/claude-4-haiku': answeringModel('x').model,
      'routexor/claude-sonnet-4.6': answeringModel('x').model,
      'ollama/qwen2.5': answeringModel('x').model,
    });
    const chain = visionChain(router, MODELS, 'anthropic/claude-opus');
    assert.deepEqual(
      chain.map((c) => c.ref),
      ['anthropic/claude-opus', 'routexor/claude-4-haiku', 'routexor/claude-sonnet-4.6'],
    );
  });

  it('skips refs whose provider key is missing', () => {
    const { router } = refRouter({ 'routexor/claude-sonnet-4.6': answeringModel('x').model });
    const chain = visionChain(router, MODELS, undefined);
    assert.deepEqual(chain.map((c) => c.ref), ['routexor/claude-sonnet-4.6']);
  });

  it('never filters the chain to empty via the breaker', () => {
    const { router, open } = refRouter({
      'routexor/claude-4-haiku': answeringModel('x').model,
      'routexor/claude-sonnet-4.6': answeringModel('x').model,
    });
    open.add('routexor/claude-4-haiku');
    open.add('routexor/claude-sonnet-4.6');
    const chain = visionChain(router, MODELS, undefined);
    assert.equal(chain.length, 2); // failsafe: all-open returns unfiltered
  });

  it('throws a sanitized error when nothing resolves', () => {
    const { router } = refRouter({});
    assert.throws(() => visionChain(router, MODELS, undefined), VisionAnalysisError);
  });
});

describe('analyzeImage', () => {
  it('happy path: sends prompt + image part, returns description and model ref', async () => {
    const primary = answeringModel('Roof shows hail bruising on the south slope.');
    const { router, successes } = refRouter({
      'routexor/claude-4-haiku': primary.model,
      'routexor/claude-sonnet-4.6': answeringModel('unused').model,
    });
    const path = tmpImage();
    const r = await analyzeImage(path, {
      router,
      models: MODELS,
      vision: vision({ prompt: 'You are a roofing damage assessor.' }),
      logger: silentLogger,
      question: 'Is this claimable?',
    });
    assert.equal(r.description, 'Roof shows hail bruising on the south slope.');
    assert.equal(r.model, 'routexor/claude-4-haiku');
    assert.deepEqual(successes, ['routexor/claude-4-haiku']);

    // The multimodal message: text part carries the operator prompt + the
    // question; an image part carries the bytes with the detected mime type.
    assert.equal(primary.calls.length, 1);
    const msg = primary.calls[0].prompt.at(-1) as {
      role: string;
      content: Array<{ type: string; text?: string; mimeType?: string }>;
    };
    assert.equal(msg.role, 'user');
    const text = msg.content.find((p) => p.type === 'text');
    assert.ok(text?.text?.includes('You are a roofing damage assessor.'));
    assert.ok(text?.text?.includes('Is this claimable?'));
    const image = msg.content.find((p) => p.type === 'image');
    assert.ok(image, 'image content part must reach the model');
    assert.equal(image?.mimeType, 'image/png');
  });

  it('falls back to the next provider and reports the failure to the breaker', async () => {
    const { router, failures, successes } = refRouter({
      'routexor/claude-4-haiku': throwingModel('402 payment required openrouter.ai'),
      'routexor/claude-sonnet-4.6': answeringModel('fallback saw the image').model,
    });
    const r = await analyzeImage(tmpImage(), {
      router,
      models: MODELS,
      vision: vision(),
      logger: silentLogger,
    });
    assert.equal(r.description, 'fallback saw the image');
    assert.equal(r.model, 'routexor/claude-sonnet-4.6');
    assert.deepEqual(failures, ['routexor/claude-4-haiku']);
    assert.deepEqual(successes, ['routexor/claude-sonnet-4.6']);
  });

  it('sanitizes total failure: no provider detail leaks out', async () => {
    const { router, failures } = refRouter({
      'routexor/claude-4-haiku': throwingModel('Error code: 402 https://openrouter.ai/credits'),
      'routexor/claude-sonnet-4.6': throwingModel('ECONNREFUSED api.provider.example:443'),
    });
    await assert.rejects(
      analyzeImage(tmpImage(), { router, models: MODELS, vision: vision(), logger: silentLogger }),
      (err: unknown) => {
        assert.ok(err instanceof VisionAnalysisError);
        for (const leak of ['402', 'openrouter', 'ECONNREFUSED', 'api.provider']) {
          assert.ok(!err.message.includes(leak), `leaked "${leak}" in: ${err.message}`);
        }
        return true;
      },
    );
    assert.equal(failures.length, 2);
  });

  it('rejects oversize images before any provider call', async () => {
    const { router } = refRouter({
      'routexor/claude-4-haiku': answeringModel('never called').model,
    });
    const path = tmpImage(2048);
    await assert.rejects(
      analyzeImage(path, { router, models: MODELS, vision: vision({ maxBytes: 1024 }) }),
      /too large/,
    );
    // Buffer input hits the same cap.
    await assert.rejects(
      analyzeImage(Buffer.alloc(2048), {
        router,
        models: MODELS,
        vision: vision({ maxBytes: 1024 }),
      }),
      /too large/,
    );
  });

  it('refuses when vision is disabled and when the file is missing', async () => {
    const { router } = refRouter({
      'routexor/claude-4-haiku': answeringModel('never called').model,
    });
    await assert.rejects(
      analyzeImage(tmpImage(), { router, models: MODELS, vision: vision({ enabled: false }) }),
      /disabled/,
    );
    await assert.rejects(
      analyzeImage('/nonexistent/nope.png', { router, models: MODELS, vision: vision() }),
      /not found/,
    );
  });
});
