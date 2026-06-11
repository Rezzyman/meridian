/**
 * runTurn × mcpGate — MCP tools are visible iff the turn's channel is in
 * the tool's gate set; voice stays clean unless armed explicitly; builtin
 * allowlisting is unaffected by the gate's existence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { tool, type LanguageModelV1StreamPart, type ToolSet } from 'ai';
import { z } from 'zod';
import { runTurn, type TurnContext } from '../../src/agent/turn.js';
import { makeConfig, mockCortex, mockRouter, silentLogger } from '../helpers/fixtures.js';

/** Model that records which tool names it was offered. */
function capturingModel(): { model: MockLanguageModelV1; offered: string[][] } {
  const offered: string[][] = [];
  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      const mode = options.mode as { tools?: Array<{ name: string }> };
      offered.push((mode.tools ?? []).map((t) => t.name).sort());
      return {
        stream: simulateReadableStream<LanguageModelV1StreamPart>({
          chunks: [
            { type: 'text-delta', textDelta: 'ok' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, offered };
}

function noopTool(description: string) {
  return tool({
    description,
    parameters: z.object({}),
    execute: async () => ({ ok: true }),
  });
}

function makeCtx(over: Partial<TurnContext>): TurnContext {
  return {
    sessionId: 's',
    config: makeConfig(),
    cortex: mockCortex(),
    router: mockRouter(),
    logger: silentLogger,
    history: [],
    channel: 'cli',
    systemBase: 'base',
    ...over,
  };
}

const tools: ToolSet = {
  web_fetch: noopTool('builtin'),
  mcp_ref_echo: noopTool('mcp tool'),
};

const gate = new Map<string, ReadonlySet<string>>([
  ['mcp_ref_echo', new Set(['cli', 'gateway', 'telegram', 'system'])],
]);

describe('runTurn mcpGate', () => {
  it('gated MCP tool is offered on cli', async () => {
    const { model, offered } = capturingModel();
    await runTurn(makeCtx({ router: mockRouter(model), tools, mcpGate: gate }), 'hi');
    assert.deepEqual(offered[0], ['mcp_ref_echo', 'web_fetch']);
  });

  it('voice never sees MCP tools under the default gate', async () => {
    const { model, offered } = capturingModel();
    await runTurn(
      makeCtx({ router: mockRouter(model), tools, mcpGate: gate, channel: 'voice' }),
      'hi',
    );
    assert.deepEqual(offered[0], ['web_fetch']);
  });

  it('voice sees an MCP tool only when armed explicitly', async () => {
    const armed = new Map<string, ReadonlySet<string>>([['mcp_ref_echo', new Set(['voice'])]]);
    const { model, offered } = capturingModel();
    await runTurn(
      makeCtx({ router: mockRouter(model), tools, mcpGate: armed, channel: 'voice' }),
      'hi',
    );
    assert.deepEqual(offered[0], ['mcp_ref_echo', 'web_fetch']);
  });

  it('a gated name is exempt from config.tools but others still need the allowlist', async () => {
    // bash is in the CLI allowlist; mcp gate doesn't grant it on gateway.
    const withBash: ToolSet = { ...tools, bash: noopTool('builtin shell') };
    const { model, offered } = capturingModel();
    await runTurn(
      makeCtx({ router: mockRouter(model), tools: withBash, mcpGate: gate, channel: 'gateway' }),
      'hi',
    );
    assert.deepEqual(offered[0], ['mcp_ref_echo', 'web_fetch']);
  });

  it('no mcpGate → behavior identical to before (regression guard)', async () => {
    const { model, offered } = capturingModel();
    await runTurn(makeCtx({ router: mockRouter(model), tools }), 'hi');
    // mcp_ref_echo is not in any allowlist and there is no gate: invisible.
    assert.deepEqual(offered[0], ['web_fetch']);
  });
});
