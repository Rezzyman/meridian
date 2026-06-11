/**
 * CONNECTIONS/mcp.json schema + loader contract.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MeridianHome } from '../../src/config/home.js';
import {
  MCP_DEFAULT_CHANNELS,
  McpServerConfigSchema,
  loadMcpConnections,
} from '../../src/mcp/config.js';

function homeWith(json?: string): MeridianHome {
  const tmp = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  const connections = join(tmp, 'CONNECTIONS');
  mkdirSync(connections, { recursive: true });
  if (json !== undefined) writeFileSync(join(connections, 'mcp.json'), json);
  return { layer: () => connections } as unknown as MeridianHome;
}

describe('McpServerConfigSchema', () => {
  it('stdio requires command', () => {
    const r = McpServerConfigSchema.safeParse({ name: 'x', transport: 'stdio' });
    assert.equal(r.success, false);
  });

  it('http/sse require url', () => {
    for (const transport of ['http', 'sse'] as const) {
      const r = McpServerConfigSchema.safeParse({ name: 'x', transport });
      assert.equal(r.success, false, transport);
    }
  });

  it('default channels exclude voice', () => {
    const r = McpServerConfigSchema.parse({ name: 'x', transport: 'stdio', command: 'true' });
    assert.deepEqual(r.channels, [...MCP_DEFAULT_CHANNELS]);
    assert.ok(!r.channels.includes('voice'));
  });

  it('voice must be armed explicitly and survives parsing', () => {
    const r = McpServerConfigSchema.parse({
      name: 'x',
      transport: 'stdio',
      command: 'true',
      channels: ['voice'],
    });
    assert.deepEqual(r.channels, ['voice']);
  });

  it('rejects names outside the tool-safe charset', () => {
    const r = McpServerConfigSchema.safeParse({
      name: 'bad name!',
      transport: 'stdio',
      command: 'true',
    });
    assert.equal(r.success, false);
  });
});

describe('loadMcpConnections', () => {
  it('missing file → empty list', () => {
    assert.deepEqual(loadMcpConnections(homeWith()), []);
  });

  it('invalid JSON throws loudly', () => {
    assert.throws(() => loadMcpConnections(homeWith('{nope')), /not valid JSON/);
  });

  it('schema violations throw (operator intent never silently dropped)', () => {
    assert.throws(() =>
      loadMcpConnections(homeWith(JSON.stringify({ servers: [{ name: 'x', transport: 'stdio' }] }))),
    );
  });

  it('duplicate names throw', () => {
    const json = JSON.stringify({
      servers: [
        { name: 'a', transport: 'stdio', command: 'true' },
        { name: 'a', transport: 'stdio', command: 'true' },
      ],
    });
    assert.throws(() => loadMcpConnections(homeWith(json)), /duplicate server name "a"/);
  });

  it('disabled servers are filtered out', () => {
    const json = JSON.stringify({
      servers: [
        { name: 'on', transport: 'stdio', command: 'true' },
        { name: 'off', transport: 'stdio', command: 'true', enabled: false },
      ],
    });
    const servers = loadMcpConnections(homeWith(json));
    assert.deepEqual(
      servers.map((s) => s.name),
      ['on'],
    );
  });
});
