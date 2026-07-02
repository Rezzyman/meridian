/**
 * meridian mcp — Model Context Protocol surface, both directions.
 *
 *   meridian mcp list            connections declared in CONNECTIONS/mcp.json,
 *                                live-probed: status + discovered tools
 *   meridian mcp serve           expose THIS agent over MCP on stdio
 *                                (memory_recall / memory_stats / memory_health;
 *                                 --allow-encode arms the write tool)
 *
 * serve is what makes CORTEX consumable from any MCP client: point
 * Claude Code / Cursor / another harness at `meridian mcp serve` and the
 * agent's memory becomes their memory_recall tool.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureAgentHome, loadAgentConfig } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { createLogger } from '../logger/pino.js';
import { createMemoryProvider } from '../memory/index.js';
import {
  connectMcpServers,
  loadMcpConnections,
  mcpConfigPath,
  McpConnectionsFileSchema,
  McpServerConfigSchema,
  type McpServerConfig,
} from '../mcp/index.js';
import { createMeridianMcpServer, serveStdio } from '../mcp/server.js';
import { ProviderRouter } from '../providers/router.js';
import { colors } from '../utils/truecolor.js';
import { pickAgentInteractive } from './agent-picker.js';

export async function runMcpList(): Promise<number> {
  const slug = await pickAgentInteractive(process.env.MERIDIAN_AGENT);
  const home = ensureAgentHome(slug);
  const logger = createLogger({ home });

  let servers: ReturnType<typeof loadMcpConnections>;
  try {
    servers = loadMcpConnections(home);
  } catch (err) {
    console.log(colors.err((err as Error).message));
    return 1;
  }
  if (servers.length === 0) {
    console.log(colors.muted('No MCP servers declared. Add them to CONNECTIONS/mcp.json:'));
    console.log(
      colors.muted(
        '  { "servers": [ { "name": "github", "transport": "stdio", "command": "npx",\n' +
          '      "args": ["-y", "@modelcontextprotocol/server-github"] } ] }',
      ),
    );
    return 0;
  }

  console.log(colors.cyan(`Probing ${servers.length} MCP server(s)…\n`));
  const surface = await connectMcpServers(servers, logger);
  for (const st of surface.status) {
    if (st.ok) {
      console.log(`  ${colors.ok('●')} ${st.server} — ${st.tools.length} tool(s)`);
      for (const t of st.tools) console.log(colors.muted(`      ${t}`));
      const cfg = servers.find((s) => s.name === st.server);
      if (cfg) console.log(colors.muted(`      channels: ${cfg.channels.join(', ')}`));
    } else {
      console.log(`  ${colors.err('●')} ${st.server} — ${st.error}`);
    }
  }
  await surface.close();
  return surface.status.every((s) => s.ok) ? 0 : 1;
}

export interface McpAddOptions {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  channels?: string[];
  force?: boolean;
}

/**
 * Validate + normalize a server entry from CLI options. Throws a clean Error
 * (readable message, no Zod blob) on invalid input, e.g. stdio without
 * --command or http without --url. Pure + exported for testing.
 */
export function buildMcpServerEntry(opts: McpAddOptions): McpServerConfig {
  const transport = opts.transport ?? 'stdio';
  const raw: Record<string, unknown> = { name: opts.name, transport };
  if (transport === 'stdio') {
    if (opts.command) raw.command = opts.command;
    if (opts.args?.length) raw.args = opts.args;
  } else if (opts.url) {
    raw.url = opts.url;
  }
  if (opts.channels?.length) raw.channels = opts.channels;
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  }
  return parsed.data;
}

/**
 * Upsert a server into a list by name. Returns a new list. Throws if the name
 * already exists and `force` is not set, so we never clobber config silently.
 * Pure + exported for testing.
 */
export function upsertMcpServer(
  servers: McpServerConfig[],
  entry: McpServerConfig,
  force: boolean,
): McpServerConfig[] {
  const idx = servers.findIndex((s) => s.name === entry.name);
  if (idx === -1) return [...servers, entry];
  if (!force) {
    throw new Error(`server "${entry.name}" already exists — pass --force to overwrite`);
  }
  const next = servers.slice();
  next[idx] = entry;
  return next;
}

/**
 * `meridian mcp add <name>` — register an MCP server in CONNECTIONS/mcp.json
 * without hand-editing JSON. stdio: `--command npx --arg -y --arg <pkg>`.
 * http/sse: `--transport http --url <url>`.
 */
export async function runMcpAdd(opts: McpAddOptions): Promise<number> {
  const slug = await pickAgentInteractive(process.env.MERIDIAN_AGENT);
  const home = ensureAgentHome(slug);
  const path = mcpConfigPath(home);

  // Read the RAW file (all servers, incl. disabled) — loadMcpConnections filters
  // to enabled-only, which would silently drop disabled entries on write-back.
  let servers: McpServerConfig[] = [];
  if (existsSync(path)) {
    try {
      servers = McpConnectionsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).servers;
    } catch (err) {
      console.log(colors.err(`CONNECTIONS/mcp.json: ${(err as Error).message}`));
      return 1;
    }
  }

  let entry: McpServerConfig;
  try {
    entry = buildMcpServerEntry(opts);
  } catch (err) {
    console.log(colors.err(`invalid server: ${(err as Error).message}`));
    return 1;
  }

  let next: McpServerConfig[];
  try {
    next = upsertMcpServer(servers, entry, opts.force ?? false);
  } catch (err) {
    console.log(colors.err((err as Error).message));
    return 1;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ servers: next }, null, 2)}\n`);
  console.log(colors.ok(`MCP server "${entry.name}" (${entry.transport}) written to ${path}`));
  console.log(colors.muted(`  visible on channels: ${entry.channels.join(', ')}`));
  console.log(
    colors.muted('  run `meridian mcp list` to probe it, then `meridian` to use its tools.'),
  );
  return 0;
}

/**
 * Remove a server from a list by name. Returns `{ servers, removed }` where
 * `removed` is false if no server matched (the caller decides that is an error).
 * Pure + exported for testing.
 */
export function removeMcpServer(
  servers: McpServerConfig[],
  name: string,
): { servers: McpServerConfig[]; removed: boolean } {
  const next = servers.filter((s) => s.name !== name);
  return { servers: next, removed: next.length !== servers.length };
}

/**
 * Set a server's `enabled` flag by name. Returns `{ servers, changed }` where
 * `changed` is false if no server matched OR it was already in the target state.
 * Pure + exported for testing.
 */
export function setMcpServerEnabled(
  servers: McpServerConfig[],
  name: string,
  enabled: boolean,
): { servers: McpServerConfig[]; changed: boolean; found: boolean } {
  let found = false;
  let changed = false;
  const next = servers.map((s) => {
    if (s.name !== name) return s;
    found = true;
    if (s.enabled === enabled) return s;
    changed = true;
    return { ...s, enabled };
  });
  return { servers: next, changed, found };
}

/** `meridian mcp enable|disable <name>` — toggle a server without losing its config. */
export async function runMcpToggle(name: string, enabled: boolean): Promise<number> {
  const slug = await pickAgentInteractive(process.env.MERIDIAN_AGENT);
  const home = ensureAgentHome(slug);
  const path = mcpConfigPath(home);
  if (!existsSync(path)) {
    console.log(colors.muted('No CONNECTIONS/mcp.json yet — nothing to toggle.'));
    return 1;
  }
  let servers: McpServerConfig[];
  try {
    servers = McpConnectionsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).servers;
  } catch (err) {
    console.log(colors.err(`CONNECTIONS/mcp.json: ${(err as Error).message}`));
    return 1;
  }
  const { servers: next, changed, found } = setMcpServerEnabled(servers, name, enabled);
  if (!found) {
    console.log(colors.err(`no MCP server named "${name}" (have: ${servers.map((s) => s.name).join(', ') || 'none'})`));
    return 1;
  }
  if (!changed) {
    console.log(colors.muted(`"${name}" is already ${enabled ? 'enabled' : 'disabled'}.`));
    return 0;
  }
  writeFileSync(path, `${JSON.stringify({ servers: next }, null, 2)}\n`);
  console.log(colors.ok(`${enabled ? 'Enabled' : 'Disabled'} MCP server "${name}".`));
  return 0;
}

/** `meridian mcp remove <name>` — drop a server from CONNECTIONS/mcp.json. */
export async function runMcpRemove(name: string): Promise<number> {
  const slug = await pickAgentInteractive(process.env.MERIDIAN_AGENT);
  const home = ensureAgentHome(slug);
  const path = mcpConfigPath(home);
  if (!existsSync(path)) {
    console.log(colors.muted('No CONNECTIONS/mcp.json yet — nothing to remove.'));
    return 1;
  }
  let servers: McpServerConfig[];
  try {
    servers = McpConnectionsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).servers;
  } catch (err) {
    console.log(colors.err(`CONNECTIONS/mcp.json: ${(err as Error).message}`));
    return 1;
  }
  const { servers: next, removed } = removeMcpServer(servers, name);
  if (!removed) {
    console.log(colors.err(`no MCP server named "${name}" (have: ${servers.map((s) => s.name).join(', ') || 'none'})`));
    return 1;
  }
  writeFileSync(path, `${JSON.stringify({ servers: next }, null, 2)}\n`);
  console.log(colors.ok(`Removed MCP server "${name}".`));
  return 0;
}

export async function runMcpServe(opts: { allowEncode?: boolean }): Promise<void> {
  // stdio transport: stdout IS the protocol channel. Nothing below may
  // console.log — the file logger is the only narrator.
  const slug = process.env.MERIDIAN_AGENT;
  if (!slug) {
    console.error('meridian mcp serve requires --agent <slug> or MERIDIAN_AGENT');
    process.exit(1);
  }
  const home = ensureAgentHome(slug);
  const config = loadAgentConfig(home);
  const env = loadAgentEnv(home);
  const logger = createLogger({ home });

  const cortex = bindCortex(env.CORTEX_AGENT_ID, env.MERIDIAN_CORTEX_URL);
  const router = new ProviderRouter(env);
  const memorySelection = await createMemoryProvider({
    env,
    router,
    cortex,
    log: (level, msg) => logger[level === 'warn' ? 'warn' : 'info']({ msg }),
  });

  const server = createMeridianMcpServer({
    provider: memorySelection.provider,
    agentName: config.agent.slug,
    allowEncode: opts.allowEncode ?? false,
  });

  logger.info({
    msg: 'mcp serve (stdio) up',
    agent: config.agent.slug,
    memoryProvider: memorySelection.selected,
    allowEncode: opts.allowEncode ?? false,
  });
  await serveStdio(server);
  // Keep the process alive until the client disconnects (stdin close).
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
}
