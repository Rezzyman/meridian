/**
 * ProviderRouter circuit breaker — call sites report outcomes, chainFor
 * skips open circuits, cooldown half-opens, and the failsafe guarantees
 * the breaker can never make availability worse than no breaker at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runTurn, type TurnContext } from '../../src/agent/turn.js';
import type { ModelChain } from '../../src/config/schema.js';
import { ProviderRouter } from '../../src/providers/router.js';
import {
  failingModel,
  makeConfig,
  makeEnv,
  mockCortex,
  mockRouter,
  silentLogger,
  textModel,
} from '../helpers/fixtures.js';

const CHAIN: ModelChain = {
  primary: 'ollama/llama-a',
  fallbacks: ['ollama/llama-b'],
  smartRouting: {
    enabled: false,
    maxSimpleChars: 200,
    maxSimpleWords: 35,
    cheapModel: 'ollama/llama-a',
  },
};

// ollama refs resolve without API keys — ideal for breaker unit tests.
function makeRouter(opts?: ConstructorParameters<typeof ProviderRouter>[1]): ProviderRouter {
  return new ProviderRouter(makeEnv(), opts);
}

describe('circuit breaker state machine', () => {
  it('opens after threshold consecutive failures and chainFor skips the ref', () => {
    const router = makeRouter({ failureThreshold: 3, cooldownMs: 60_000 });
    const refs = () => router.chainFor('long enough input', CHAIN).map((p) => p.ref);

    router.reportFailure('ollama/llama-a');
    router.reportFailure('ollama/llama-a');
    assert.deepEqual(refs(), ['ollama/llama-a', 'ollama/llama-b'], 'below threshold: closed');

    router.reportFailure('ollama/llama-a');
    assert.equal(router.isOpen('ollama/llama-a'), true);
    assert.deepEqual(refs(), ['ollama/llama-b'], 'open circuit filtered from the chain');
  });

  it('success closes the circuit and resets the failure count', () => {
    const router = makeRouter({ failureThreshold: 2, cooldownMs: 60_000 });
    router.reportFailure('ollama/llama-a');
    router.reportSuccess('ollama/llama-a');
    router.reportFailure('ollama/llama-a');
    assert.equal(router.isOpen('ollama/llama-a'), false, 'count restarted after success');
  });

  it('cooldown expiry half-opens: one probe allowed, a failure re-opens immediately', async () => {
    const router = makeRouter({ failureThreshold: 2, cooldownMs: 30 });
    router.reportFailure('ollama/llama-a');
    router.reportFailure('ollama/llama-a');
    assert.equal(router.isOpen('ollama/llama-a'), true);

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(router.isOpen('ollama/llama-a'), false, 'half-open after cooldown');
    router.reportFailure('ollama/llama-a');
    assert.equal(router.isOpen('ollama/llama-a'), true, 'single probe failure re-opens');
  });

  it('failsafe: when every ref is open the chain is returned unfiltered', () => {
    const router = makeRouter({ failureThreshold: 1, cooldownMs: 60_000 });
    router.reportFailure('ollama/llama-a');
    router.reportFailure('ollama/llama-b');
    const refs = router.chainFor('long enough input', CHAIN).map((p) => p.ref);
    assert.deepEqual(refs, ['ollama/llama-a', 'ollama/llama-b']);
  });
});

describe('runTurn feeds the breaker', () => {
  function spyRouter(...models: Parameters<typeof mockRouter>) {
    const router = mockRouter(...models);
    const failures: string[] = [];
    const successes: string[] = [];
    (router as unknown as Record<string, unknown>).reportFailure = (ref: string) =>
      failures.push(ref);
    (router as unknown as Record<string, unknown>).reportSuccess = (ref: string) =>
      successes.push(ref);
    return { router, failures, successes };
  }

  function ctx(router: TurnContext['router']): TurnContext {
    return {
      sessionId: 's',
      config: makeConfig(),
      cortex: mockCortex(),
      router,
      logger: silentLogger,
      history: [],
      channel: 'cli',
      systemBase: 'base',
    };
  }

  it('reports failure for the dead primary and success for the fallback', async () => {
    const { router, failures, successes } = spyRouter(failingModel('down'), textModel('ok'));
    await runTurn(ctx(router), 'hi');
    assert.deepEqual(failures, ['anthropic/mock-0']);
    assert.deepEqual(successes, ['anthropic/mock-1']);
  });

  it('reports success only, on a clean first-provider turn', async () => {
    const { router, failures, successes } = spyRouter(textModel('ok'));
    await runTurn(ctx(router), 'hi');
    assert.deepEqual(failures, []);
    assert.deepEqual(successes, ['anthropic/mock-0']);
  });
});
