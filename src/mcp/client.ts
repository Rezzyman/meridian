/**
 * MCP client — consume external MCP servers as first-class Meridian tools.
 *
 * Servers declared in CONNECTIONS/mcp.json are connected at boot, their
 * tools discovered over the protocol and surfaced into the agent's ToolSet
 * as `mcp_<server>_<tool>`. Built on @modelcontextprotocol/sdk (official),
 * with AI SDK's jsonSchema() bridging MCP's JSON-Schema tool inputs into
 * the tool() shape the turn loop already speaks — no schema translation
 * layer, no second MCP implementation.
 *
 * Failure posture: one unreachable server must never take the agent down.
 * Connect errors are reported per-server and the boot continues; call-time
 * errors return the house `{ ok: false, error }` shape so the model can
 * self-correct instead of the turn exploding.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type { Logger } from 'pino';
import type { McpServerConfig } from './config.js';

export interface McpToolSurface {
  /** AI-SDK tools, keyed `mcp_<server>_<tool>` — merge into the agent ToolSet. */
  tools: ToolSet;
  /** toolName → channels allowed to see it (drives per-channel gating in runTurn). */
  channelGate: Map<string, ReadonlySet<string>>;
  /** Per-server connection status for doctor / `meridian mcp list`. */
  status: Array<{
    server: string;
    ok: boolean;
    tools: string[];
    error?: string;
  }>;
  /** Disconnect every server. Idempotent. */
  close(): Promise<void>;
}

interface LiveConnection {
  name: string;
  client: Client;
}

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

function buildTransport(cfg: McpServerConfig): Transport {
  switch (cfg.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: cfg.command as string,
        args: cfg.args,
        env: { ...filterEnv(process.env), ...cfg.env },
        stderr: 'ignore',
      });
    case 'http':
      return new StreamableHTTPClientTransport(new URL(cfg.url as string), {
        requestInit: { headers: cfg.headers },
      });
    case 'sse':
      return new SSEClientTransport(new URL(cfg.url as string), {
        requestInit: { headers: cfg.headers },
      });
  }
}

/** Pass through only defined env values (ProcessEnv has string|undefined). */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** `mcp_<server>_<tool>`, sanitized to the provider-safe name charset. */
export function mcpToolName(server: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp_${clean(server)}_${clean(toolName)}`;
}

/**
 * Connect the configured MCP servers and assemble their tool surface.
 * Per-server failures are isolated: reported in `status`, logged, skipped.
 */
export async function connectMcpServers(
  servers: McpServerConfig[],
  logger: Logger,
): Promise<McpToolSurface> {
  const tools: ToolSet = {};
  const channelGate = new Map<string, ReadonlySet<string>>();
  const status: McpToolSurface['status'] = [];
  const live: LiveConnection[] = [];

  for (const cfg of servers) {
    const client = new Client({ name: 'meridian', version: '1.1.0' });
    try {
      await withTimeout(
        client.connect(buildTransport(cfg)),
        CONNECT_TIMEOUT_MS,
        `MCP connect ${cfg.name}`,
      );
      const listed = await withTimeout(
        client.listTools(),
        CONNECT_TIMEOUT_MS,
        `MCP listTools ${cfg.name}`,
      );
      const channels = new Set(cfg.channels);
      const names: string[] = [];
      for (const t of listed.tools) {
        const name = mcpToolName(cfg.name, t.name);
        names.push(name);
        channelGate.set(name, channels);
        tools[name] = tool({
          description: `[MCP:${cfg.name}] ${t.description ?? t.name}`,
          parameters: jsonSchema<Record<string, unknown>>(
            (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          ),
          execute: async (args: Record<string, unknown>) => {
            try {
              const result = await withTimeout(
                client.callTool({ name: t.name, arguments: args }),
                CALL_TIMEOUT_MS,
                `MCP call ${cfg.name}/${t.name}`,
              );
              return {
                ok: result.isError !== true,
                ...(result.isError === true ? { error: flattenContent(result.content) } : {}),
                content: flattenContent(result.content),
              };
            } catch (err) {
              // House convention: tools return structured failure, never throw —
              // the model sees the error and can self-correct within the turn.
              return { ok: false, error: (err as Error).message };
            }
          },
        });
      }
      live.push({ name: cfg.name, client });
      status.push({ server: cfg.name, ok: true, tools: names });
      logger.info({ msg: 'mcp server connected', server: cfg.name, tools: names.length });
    } catch (err) {
      const message = (err as Error).message;
      status.push({ server: cfg.name, ok: false, tools: [], error: message });
      logger.warn({ msg: 'mcp server unavailable; skipping', server: cfg.name, err: message });
      try {
        await client.close();
      } catch {
        // already dead — nothing to release
      }
    }
  }

  let closed = false;
  return {
    tools,
    channelGate,
    status,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(live.map((c) => c.client.close()));
    },
  };
}

/** MCP content blocks → single string (text blocks joined; others JSON-encoded). */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content);
  return content
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        return (block as { text?: string }).text ?? '';
      }
      return JSON.stringify(block);
    })
    .join('\n');
}
