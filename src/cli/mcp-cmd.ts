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

import { ensureAgentHome, loadAgentConfig } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { createLogger } from '../logger/pino.js';
import { createMemoryProvider } from '../memory/index.js';
import { connectMcpServers, loadMcpConnections } from '../mcp/index.js';
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
