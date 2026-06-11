/**
 * MCP — Model Context Protocol, both directions.
 *
 * Client: CONNECTIONS/mcp.json servers → first-class tools in the loadout,
 * channel-gated (voice excluded by default).
 * Server: this agent's CORTEX memory surface, consumable by any MCP client.
 */

export {
  loadMcpConnections,
  mcpConfigPath,
  McpConnectionsFileSchema,
  McpServerConfigSchema,
  MCP_DEFAULT_CHANNELS,
  type McpServerConfig,
  type McpConnectionsFile,
} from './config.js';
export { connectMcpServers, mcpToolName, type McpToolSurface } from './client.js';
export { createMeridianMcpServer, serveStdio, type MeridianMcpServerOptions } from './server.js';
