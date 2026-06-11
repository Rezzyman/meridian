/**
 * Meridian MCP server — the agent's CORTEX surface over the protocol.
 * In-process interop via InMemoryTransport + the official SDK Client.
 * Isolation invariants under test: agentId is pinned (never a parameter),
 * external reads are public-sensitivity only, encode is opt-in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMeridianMcpServer } from '../../src/mcp/server.js';
import { type MockCortex, mockCortex } from '../helpers/fixtures.js';

type TextContent = Array<{ type: string; text: string }>;

async function connectedClient(opts: {
  cortex?: MockCortex;
  allowEncode?: boolean;
}): Promise<{ client: Client; cortex: MockCortex }> {
  const cortex = opts.cortex ?? mockCortex({ recallContext: 'ctx-block' });
  const server = createMeridianMcpServer({
    provider: cortex,
    agentName: 'eval-agent',
    allowEncode: opts.allowEncode,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return { client, cortex };
}

describe('createMeridianMcpServer', () => {
  it('default surface is read-only: recall + stats + health, no encode', async () => {
    const { client } = await connectedClient({});
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['memory_health', 'memory_recall', 'memory_stats'],
    );
    await client.close();
  });

  it('allowEncode arms memory_encode', async () => {
    const { client } = await connectedClient({ allowEncode: true });
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'memory_encode'));
    await client.close();
  });

  it('memory_recall round-trips and pins sensitivity to public', async () => {
    const { client, cortex } = await connectedClient({});
    const res = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'what do I drink', tokenBudget: 900 },
    });
    const body = JSON.parse((res.content as TextContent)[0].text);
    assert.equal(body.context, 'ctx-block');
    assert.ok(Array.isArray(body.memories));
    assert.equal(cortex.recallCalls.length, 1);
    assert.equal(cortex.recallCalls[0].opts?.tokenBudget, 900);
    // External callers are the same trust class as the public voice line.
    assert.deepEqual(cortex.recallCalls[0].opts?.sensitivityFilter, ['public']);
    await client.close();
  });

  it('memory_encode writes with public sensitivity + mcp channel attribution', async () => {
    const { client, cortex } = await connectedClient({ allowEncode: true });
    const res = await client.callTool({
      name: 'memory_encode',
      arguments: { content: 'caller fact', source: 'mcp:test' },
    });
    assert.notEqual(res.isError, true);
    assert.equal(cortex.encodeCalls.length, 1);
    assert.equal(cortex.encodeCalls[0].content, 'caller fact');
    assert.equal(cortex.encodeCalls[0].opts?.sensitivity, 'public');
    assert.equal(cortex.encodeCalls[0].opts?.channel, 'mcp');
    assert.equal(cortex.encodeCalls[0].opts?.source, 'mcp:test');
    await client.close();
  });

  it('provider failure surfaces as isError, not a protocol crash', async () => {
    const broken = mockCortex({ recallError: new Error('CORTEX /recall 503: down') });
    const { client } = await connectedClient({ cortex: broken });
    const res = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'x' },
    });
    assert.equal(res.isError, true);
    assert.match((res.content as TextContent)[0].text, /503/);
    await client.close();
  });

  it('memory_stats reports unreachable backend as isError', async () => {
    // mockCortex.stats() returns null = transport failure contract.
    const { client } = await connectedClient({});
    const res = await client.callTool({ name: 'memory_stats', arguments: {} });
    assert.equal(res.isError, true);
    assert.match((res.content as TextContent)[0].text, /unreachable/i);
    await client.close();
  });
});
