/**
 * ProviderRouter unit tests. resolve() only constructs SDK model objects —
 * no network. Key presence/absence is driven through makeEnv overrides.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRouter } from '../../src/providers/router.js';
import type { ModelChain } from '../../src/config/schema.js';
import { makeEnv } from '../helpers/fixtures.js';

// Syntactically valid dummy keys — never live.
const ALL_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  OPENAI_API_KEY: 'sk-openai-test-key',
  GROQ_API_KEY: 'gsk-groq-test-key',
  ROUTEXOR_API_KEY: 'rx-test-key',
};

function makeChain(overrides: Partial<ModelChain> = {}): ModelChain {
  return {
    primary: 'anthropic/claude-x',
    fallbacks: [],
    smartRouting: {
      enabled: false,
      maxSimpleChars: 200,
      maxSimpleWords: 35,
      cheapModel: 'groq/llama-cheap',
    },
    ...overrides,
  };
}

describe('ProviderRouter.resolve', () => {
  it('resolves anthropic ref into provider/modelId/ref/model', () => {
    const router = new ProviderRouter(makeEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));
    const resolved = router.resolve('anthropic/claude-x');
    assert.equal(resolved.provider, 'anthropic');
    assert.equal(resolved.modelId, 'claude-x');
    assert.equal(resolved.ref, 'anthropic/claude-x');
    assert.ok(resolved.model, 'model object is constructed');
  });

  it('passes the ROUTEXOR catalog model id through (the default router) intact', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    const resolved = router.resolve('routexor/claude-sonnet-4.6');
    assert.equal(resolved.provider, 'routexor');
    assert.equal(resolved.modelId, 'claude-sonnet-4.6');
    assert.equal(resolved.ref, 'routexor/claude-sonnet-4.6');
    assert.ok(resolved.model, 'model object is constructed');
  });

  it('honors a custom ROUTEXOR_BASE_URL without throwing', () => {
    const router = new ProviderRouter(
      makeEnv({ ROUTEXOR_API_KEY: 'rx-test-key', ROUTEXOR_BASE_URL: 'https://rtx.internal/v1' }),
    );
    assert.ok(router.resolve('routexor/some-model').model);
  });

  it('keyless proxy seam: resolves routexor with NO key when ROUTEXOR_BASE_URL is set', () => {
    // A hosted control plane points agents at a server-side key-injecting
    // proxy. The blank key must not throw here, and must not fall through to
    // OPENAI_API_KEY (the placeholder bearer prevents the AI SDK's fallback).
    const router = new ProviderRouter(makeEnv({ ROUTEXOR_BASE_URL: 'https://proxy.internal/v1' }));
    const resolved = router.resolve('routexor/claude-4-haiku');
    assert.equal(resolved.provider, 'routexor');
    assert.ok(resolved.model, 'model constructed with the placeholder bearer');
  });

  it('keyless seam does not weaken the default path (no key, no base URL → same actionable error)', () => {
    const router = new ProviderRouter(makeEnv());
    assert.throws(() => router.resolve('routexor/claude-4-haiku'), /ROUTEXOR_API_KEY/);
    assert.throws(() => router.resolve('routexor/claude-4-haiku'), /routexor\.com/);
    assert.throws(() => router.resolve('routexor/claude-4-haiku'), /dashboard/);
  });

  it('throws naming the env var when the provider key is missing', () => {
    // Default makeEnv has none of the LLM provider keys set.
    const router = new ProviderRouter(makeEnv());
    assert.throws(() => router.resolve('anthropic/claude-x'), /ANTHROPIC_API_KEY/);
    assert.throws(() => router.resolve('openai/gpt-5'), /OPENAI_API_KEY/);
    assert.throws(() => router.resolve('groq/llama-3.3-70b'), /GROQ_API_KEY/);
    assert.throws(() => router.resolve('routexor/claude-4-haiku'), /ROUTEXOR_API_KEY/);
  });

  it('the routexor missing-key error is actionable (points to routexor.com)', () => {
    // The default-router error is a new user's most likely first failure, so it
    // must tell them where to get a key rather than dead-end. Locks the onboarding UX.
    const router = new ProviderRouter(makeEnv());
    assert.throws(() => router.resolve('routexor/claude-4-haiku'), /routexor\.com/);
  });

  it('resolves ollama refs with no API key at all', () => {
    const router = new ProviderRouter(makeEnv());
    const resolved = router.resolve('ollama/llama3.2');
    assert.equal(resolved.provider, 'ollama');
    assert.equal(resolved.modelId, 'llama3.2');
    assert.ok(resolved.model);
  });

  it('caches by ref: same ref returns the identical model instance', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    const first = router.resolve('anthropic/claude-x');
    const second = router.resolve('anthropic/claude-x');
    assert.equal(second.model, first.model); // === identity, not a rebuilt instance
    const other = router.resolve('anthropic/claude-y');
    assert.notEqual(other.model, first.model);
  });

  it('throws on invalid ref with no slash', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    assert.throws(() => router.resolve('claude-x'), /invalid model ref: claude-x/);
  });

  it('throws on unknown provider name', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    assert.throws(() => router.resolve('nosuch/model-x'), /unknown provider: nosuch/);
  });
});

describe('ProviderRouter.chainFor', () => {
  it('long input → [primary, ...fallbacks] in order, with repeated refs deduped', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    const chain = makeChain({
      primary: 'anthropic/claude-x',
      // primary repeated in fallbacks must be deduped; groq listed twice too
      fallbacks: ['openai/gpt-5', 'anthropic/claude-x', 'groq/llama-3.3-70b', 'groq/llama-3.3-70b'],
      smartRouting: {
        enabled: true,
        maxSimpleChars: 200,
        maxSimpleWords: 35,
        cheapModel: 'groq/llama-cheap',
      },
    });
    const longInput = 'x'.repeat(300); // > maxSimpleChars → not simple even with routing enabled
    const out = router.chainFor(longInput, chain);
    assert.deepEqual(
      out.map((r) => r.ref),
      ['anthropic/claude-x', 'openai/gpt-5', 'groq/llama-3.3-70b'],
    );
  });

  it('word count alone can disqualify a short-char input from smart routing', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    const chain = makeChain({
      smartRouting: {
        enabled: true,
        maxSimpleChars: 200,
        maxSimpleWords: 35,
        cheapModel: 'groq/llama-cheap',
      },
    });
    const manyWords = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '); // < 200 chars, 40 words
    const out = router.chainFor(manyWords, chain);
    assert.equal(out[0].ref, 'anthropic/claude-x'); // primary, not cheapModel
  });

  it('smart routing + short input → cheapModel first and primary is DROPPED', () => {
    const router = new ProviderRouter(makeEnv(ALL_KEYS));
    const chain = makeChain({
      primary: 'anthropic/claude-x',
      fallbacks: ['openai/gpt-5'],
      smartRouting: {
        enabled: true,
        maxSimpleChars: 200,
        maxSimpleWords: 35,
        cheapModel: 'groq/llama-cheap',
      },
    });
    const out = router.chainFor('hi there', chain);
    // ACTUAL behavior per src: cheapModel REPLACES primary in the refs list; primary is not
    // appended afterwards, so it only appears if it is also listed in fallbacks.
    assert.deepEqual(
      out.map((r) => r.ref),
      ['groq/llama-cheap', 'openai/gpt-5'],
    );
    assert.ok(!out.some((r) => r.ref === 'anthropic/claude-x'));
  });

  it('silently skips unresolvable refs (typo provider, missing key, malformed ref)', () => {
    // Only ANTHROPIC key set: openai ref lacks a key, 'nosuch' is a typo provider,
    // 'noslash' is malformed. None should throw inside chainFor.
    const router = new ProviderRouter(makeEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));
    const chain = makeChain({
      primary: 'nosuch/model-x',
      fallbacks: ['openai/gpt-5', 'noslash', 'anthropic/claude-x', 'ollama/llama3.2'],
    });
    const out = router.chainFor('x'.repeat(300), chain);
    assert.deepEqual(
      out.map((r) => r.ref),
      ['anthropic/claude-x', 'ollama/llama3.2'],
    );
  });

  it('throws when every ref in the chain is unresolvable', () => {
    const router = new ProviderRouter(makeEnv()); // no LLM keys
    const chain = makeChain({
      primary: 'anthropic/claude-x',
      fallbacks: ['openai/gpt-5', 'groq/llama-3.3-70b'],
    });
    assert.throws(() => router.chainFor('hello', chain), /No providers resolvable/);
  });
});
