/**
 * Reference MCP server (stdio) for client interop tests.
 * Two tools: `echo` (round-trips its input) and `boom` (always isError).
 * Run: node --import tsx test/fixtures/mcp-ref-server.mts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ref', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echo the message back',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
);

server.registerTool(
  'boom',
  {
    description: 'Always fails',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: 'kaboom' }], isError: true }),
);

await server.connect(new StdioServerTransport());
