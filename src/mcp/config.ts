/**
 * MCP connections config — CONNECTIONS/mcp.json.
 *
 * The CONNECTIONS layer reserves mcp.json for the MCP servers this agent
 * may consume. Like every Meridian config, it crosses through zod before
 * reaching code paths. Missing file = no MCP servers (zero-cost default);
 * a malformed file is a loud error, not a silent skip — an operator who
 * wrote the file wants it honored.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MeridianHome } from '../config/home.js';

/** Channels MCP tools may surface on. Voice is excluded BY DEFAULT —
 *  the public phone line never gains tools by side effect; an operator
 *  must list 'voice' explicitly per server to arm it there. */
export const MCP_DEFAULT_CHANNELS = ['cli', 'gateway', 'telegram', 'system'] as const;

export const McpServerConfigSchema = z
  .object({
    /** Unique name; becomes the tool prefix `mcp_<name>_<tool>`. */
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'name must be alphanumeric with - or _'),
    transport: z.enum(['stdio', 'http', 'sse']),
    /** stdio transport */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    /** http (streamable) / sse transports */
    url: z.string().url().optional(),
    headers: z.record(z.string()).default({}),
    enabled: z.boolean().default(true),
    /** Per-channel gate for this server's tools. */
    channels: z
      .array(z.enum(['cli', 'telegram', 'voice', 'gateway', 'system']))
      .default([...MCP_DEFAULT_CHANNELS]),
  })
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio' && !v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio transport requires "command"' });
    }
    if ((v.transport === 'http' || v.transport === 'sse') && !v.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${v.transport} transport requires "url"`,
      });
    }
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConnectionsFileSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
});
export type McpConnectionsFile = z.infer<typeof McpConnectionsFileSchema>;

export function mcpConfigPath(home: MeridianHome): string {
  return join(home.layer('CONNECTIONS'), 'mcp.json');
}

/**
 * Load + validate CONNECTIONS/mcp.json. Returns only enabled servers.
 * Missing file → []. Malformed file → throws (operator intent must not
 * be silently dropped).
 */
export function loadMcpConnections(home: MeridianHome): McpServerConfig[] {
  const path = mcpConfigPath(home);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`CONNECTIONS/mcp.json is not valid JSON: ${(err as Error).message}`);
  }
  const file = McpConnectionsFileSchema.parse(parsed);
  const seen = new Set<string>();
  for (const s of file.servers) {
    if (seen.has(s.name)) {
      throw new Error(`CONNECTIONS/mcp.json: duplicate server name "${s.name}"`);
    }
    seen.add(s.name);
  }
  return file.servers.filter((s) => s.enabled);
}
