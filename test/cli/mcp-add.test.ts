/**
 * `meridian mcp add` — the pure entry-building and upsert logic that lets users
 * register an MCP server without hand-editing JSON. IO is a thin wrapper around
 * these; the validation + dedup rules live here and are fully testable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMcpServerEntry, removeMcpServer, upsertMcpServer } from '../../src/cli/mcp-cmd.js';
import type { McpServerConfig } from '../../src/mcp/index.js';

describe('buildMcpServerEntry', () => {
  it('builds a stdio server with command + args and defaults', () => {
    const e = buildMcpServerEntry({
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    assert.equal(e.name, 'github');
    assert.equal(e.transport, 'stdio');
    assert.equal(e.command, 'npx');
    assert.deepEqual(e.args, ['-y', '@modelcontextprotocol/server-github']);
    assert.equal(e.enabled, true);
    assert.ok(e.channels.length > 0, 'gets default channels');
  });

  it('builds an http server from a url', () => {
    const e = buildMcpServerEntry({ name: 'data', transport: 'http', url: 'https://mcp.example.com/x' });
    assert.equal(e.transport, 'http');
    assert.equal(e.url, 'https://mcp.example.com/x');
  });

  it('honors explicit channels', () => {
    const e = buildMcpServerEntry({ name: 'g', command: 'x', channels: ['cli', 'gateway'] });
    assert.deepEqual(e.channels, ['cli', 'gateway']);
  });

  it('rejects a stdio server with no command (clean message, no zod blob)', () => {
    assert.throws(
      () => buildMcpServerEntry({ name: 'broken' }),
      /stdio transport requires "command"/,
    );
  });

  it('rejects an http server with no url', () => {
    assert.throws(
      () => buildMcpServerEntry({ name: 'broken', transport: 'http' }),
      /http transport requires "url"/,
    );
  });

  it('rejects an invalid name', () => {
    assert.throws(() => buildMcpServerEntry({ name: 'bad name!', command: 'x' }), /name must be/);
  });
});

describe('upsertMcpServer', () => {
  const a = buildMcpServerEntry({ name: 'a', command: 'x' });
  const bDisabled = { ...buildMcpServerEntry({ name: 'b', command: 'y' }), enabled: false };

  it('appends a new server', () => {
    const out = upsertMcpServer([a as McpServerConfig], buildMcpServerEntry({ name: 'c', command: 'z' }), false);
    assert.deepEqual(out.map((s) => s.name), ['a', 'c']);
  });

  it('refuses to clobber an existing name without force', () => {
    assert.throws(
      () => upsertMcpServer([a as McpServerConfig], buildMcpServerEntry({ name: 'a', command: 'q' }), false),
      /already exists — pass --force/,
    );
  });

  it('overwrites in place with force, preserving order and other servers', () => {
    const servers = [a as McpServerConfig, bDisabled as McpServerConfig];
    const replacement = buildMcpServerEntry({ name: 'a', command: 'NEW' });
    const out = upsertMcpServer(servers, replacement, true);
    assert.deepEqual(out.map((s) => s.name), ['a', 'b'], 'order preserved');
    assert.equal(out[0].command, 'NEW', 'entry replaced');
    assert.equal(out[1].enabled, false, 'a disabled sibling is not dropped');
  });

  it('does not mutate the input array', () => {
    const servers = [a as McpServerConfig];
    upsertMcpServer(servers, buildMcpServerEntry({ name: 'z', command: 'x' }), false);
    assert.equal(servers.length, 1, 'input untouched');
  });
});

describe('removeMcpServer', () => {
  const a = buildMcpServerEntry({ name: 'a', command: 'x' });
  const b = buildMcpServerEntry({ name: 'b', command: 'y' });

  it('removes a matching server and reports removed=true', () => {
    const { servers, removed } = removeMcpServer([a, b] as McpServerConfig[], 'a');
    assert.equal(removed, true);
    assert.deepEqual(servers.map((s) => s.name), ['b']);
  });

  it('reports removed=false when nothing matched (caller treats as error)', () => {
    const { servers, removed } = removeMcpServer([a] as McpServerConfig[], 'nope');
    assert.equal(removed, false);
    assert.deepEqual(servers.map((s) => s.name), ['a']);
  });

  it('does not mutate the input', () => {
    const input = [a, b] as McpServerConfig[];
    removeMcpServer(input, 'a');
    assert.equal(input.length, 2);
  });
});
