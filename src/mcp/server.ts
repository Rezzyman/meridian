/**
 * Meridian MCP server — expose this agent's cognitive surface to ANY MCP
 * client (Claude Code, Cursor, another harness, another Meridian).
 *
 * The headline tool is CORTEX recall: the #1-benched memory system for
 * agentic AI, reachable over the open protocol. A harness with no memory
 * of its own can plug a Meridian agent in as its long-term memory.
 *
 * Isolation is non-negotiable: the served MemoryProvider is bound to ONE
 * agentId at construction. agent_id is NEVER a tool parameter — an MCP
 * caller can only reach the namespace this server was started for.
 * Encode (memory WRITE) is opt-in via `allowEncode`; the default surface
 * is read-only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { MemoryProvider } from '../memory/provider.js';

export interface MeridianMcpServerOptions {
  /** Bound memory provider — carries the pinned agentId. */
  provider: MemoryProvider;
  agentName: string;
  /** Allow the memory_encode (write) tool. Default false: read-only surface. */
  allowEncode?: boolean;
}

function text(s: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: s }] };
}

function errorResult(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
}

/** Build (but do not connect) the MCP server for one agent. */
export function createMeridianMcpServer(opts: MeridianMcpServerOptions): McpServer {
  const { provider, agentName, allowEncode = false } = opts;

  const server = new McpServer({
    name: `meridian-${agentName}`,
    version: '1.1.0',
  });

  server.registerTool(
    'memory_recall',
    {
      title: 'CORTEX memory recall',
      description:
        `Pattern-completion recall from ${agentName}'s CORTEX cognitive memory. ` +
        'Returns an LLM-ready context block plus the matching memories with relevance scores. ' +
        'Use for: what does this agent know/remember about X.',
      inputSchema: {
        query: z.string().min(1).describe('What to recall — natural language'),
        tokenBudget: z
          .number()
          .int()
          .min(100)
          .max(16000)
          .default(1500)
          .describe('Max tokens of recalled context'),
      },
    },
    async ({ query, tokenBudget }) => {
      try {
        const r = await provider.recall(query, {
          tokenBudget,
          // Public sensitivity only: an MCP caller is an external surface,
          // same trust class as the public voice line.
          sensitivityFilter: ['public'],
        });
        return text(
          JSON.stringify(
            {
              context: r.context,
              memories: r.memories.map((m) => ({ id: m.id, content: m.content, score: m.score })),
              tokenCount: r.tokenCount,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'memory_stats',
    {
      title: 'CORTEX memory stats',
      description: `Memory-graph counts for ${agentName}: active memories, synaptic connections, last dream cycle.`,
      inputSchema: {},
    },
    async () => {
      try {
        const s = await provider.stats();
        if (!s) return errorResult(new Error('CORTEX unreachable'));
        return text(JSON.stringify(s, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'memory_health',
    {
      title: 'CORTEX health',
      description: 'Liveness of the agent memory backend.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(JSON.stringify(await provider.health(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  if (allowEncode) {
    server.registerTool(
      'memory_encode',
      {
        title: 'CORTEX memory encode',
        description:
          `Write a memory into ${agentName}'s CORTEX (hippocampal encode). ` +
          'Enabled because this server was started with --allow-encode.',
        inputSchema: {
          content: z.string().min(1).describe('The memory content to encode'),
          source: z.string().default('mcp:external').describe('Attribution tag'),
          priority: z.number().int().min(0).max(4).default(2),
        },
      },
      async ({ content, source, priority }) => {
        try {
          const r = await provider.encode(content, {
            source,
            priority,
            channel: 'mcp',
            // External writes land as public; sacred/internal memory is
            // never authored over an external protocol surface.
            sensitivity: 'public',
          });
          return text(JSON.stringify(r));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  return server;
}

/** Connect the server over stdio (the `meridian mcp serve` path). */
export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
