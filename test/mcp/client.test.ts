/**
 * MCP client interop — REAL process boundary. connectMcpServers spawns the
 * reference stdio server fixture (test/fixtures/mcp-ref-server.mts) and we
 * assert discovery, naming, channel gating, call round-trips, error
 * isolation, and lifecycle against the live protocol.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Tool } from 'ai';
import { McpServerConfigSchema } from '../../src/mcp/config.js';
import { connectMcpServers, mcpToolName, type McpToolSurface } from '../../src/mcp/client.js';
import { silentLogger } from '../helpers/fixtures.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-ref-server.mts');

function refServerConfig(name = 'ref') {
  return McpServerConfigSchema.parse({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE],
  });
}

const surfaces: McpToolSurface[] = [];
async function connect(...cfgs: ReturnType<typeof refServerConfig>[]): Promise<McpToolSurface> {
  const surface = await connectMcpServers(cfgs, silentLogger);
  surfaces.push(surface);
  return surface;
}

after(async () => {
  await Promise.all(surfaces.map((s) => s.close()));
});

describe('mcpToolName', () => {
  it('prefixes and sanitizes', () => {
    assert.equal(mcpToolName('ref', 'echo'), 'mcp_ref_echo');
    assert.equal(mcpToolName('my-server', 'get.thing'), 'mcp_my_server_get_thing');
  });
});

describe('connectMcpServers over stdio (real process)', () => {
  it('discovers tools, prefixes names, gates channels (no voice by default)', async () => {
    const surface = await connect(refServerConfig());
    assert.deepEqual(surface.status, [
      { server: 'ref', ok: true, tools: ['mcp_ref_echo', 'mcp_ref_boom'] },
    ]);
    assert.deepEqual(Object.keys(surface.tools).sort(), ['mcp_ref_boom', 'mcp_ref_echo']);

    const gate = surface.channelGate.get('mcp_ref_echo');
    assert.ok(gate, 'gate registered');
    for (const ch of ['cli', 'gateway', 'telegram', 'system']) assert.ok(gate.has(ch), ch);
    assert.ok(!gate.has('voice'), 'voice never gains MCP tools by default');
  });

  it('round-trips a tool call through the protocol', async () => {
    const surface = await connect(refServerConfig());
    const echo = surface.tools.mcp_ref_echo as Required<Tool>;
    const result = (await echo.execute(
      { message: 'hello interop' },
      { toolCallId: 't1', messages: [] },
    )) as { ok: boolean; content: string };
    assert.equal(result.ok, true);
    assert.equal(result.content, 'echo: hello interop');
  });

  it('maps isError results to the house { ok: false } shape (model can self-correct)', async () => {
    const surface = await connect(refServerConfig());
    const boom = surface.tools.mcp_ref_boom as Required<Tool>;
    const result = (await boom.execute({}, { toolCallId: 't2', messages: [] })) as {
      ok: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error, /kaboom/);
  });

  it('isolates a dead server: boot continues, status reports the failure', async () => {
    const dead = McpServerConfigSchema.parse({
      name: 'dead',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    });
    const surface = await connect(dead, refServerConfig('alive'));
    const byName = Object.fromEntries(surface.status.map((s) => [s.server, s]));
    assert.equal(byName.dead.ok, false);
    assert.ok(byName.dead.error, 'failure reason recorded');
    assert.equal(byName.alive.ok, true);
    assert.deepEqual(byName.alive.tools, ['mcp_alive_echo', 'mcp_alive_boom']);
  });

  it('close() is idempotent', async () => {
    const surface = await connect(refServerConfig());
    await surface.close();
    await surface.close();
  });
});
