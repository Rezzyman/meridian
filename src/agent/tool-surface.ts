/**
 * buildToolSurface — the ONE place an agent's tool surface is assembled.
 *
 * Builtins + v2 skill tools + MCP server tools, with the vault/passphrase
 * plumbing they need. The REPL (cli/main.ts) and the gateway
 * (cli/gateway-cmd.ts) both boot through here; before this existed the two
 * sites were near-duplicate blocks that had to be patched in lockstep for
 * every new tool source.
 *
 * Order matters in the merge: builtins < skill tools < MCP tools. A name
 * collision is resolved toward the more explicit opt-in (an operator who
 * declared an MCP server outranks a bundled default).
 */

import { tool as aiTool, type ToolSet } from 'ai';
import type { Logger } from 'pino';
import { z as zod } from 'zod';
import type { CortexBind } from '../cortex/bind.js';
import type { MeridianHome } from '../config/home.js';
import type { AgentConfig, AgentEnv } from '../config/schema.js';
import { collectSkillEnv } from '../config/loader.js';
import { connectMcpServers, loadMcpConnections, type McpToolSurface } from '../mcp/index.js';
import { openAgentVault, type Vault } from '../secrets/vault.js';
import { builtinTools } from '../skills/builtin/index.js';
import { loadSkills, prescanManifestEnvKeys } from '../skills/loader.js';
import { PassphraseGuard } from '../skills/runtime.js';
import type { SkillRegistry } from '../skills/types.js';
import { listAccounts as gogListAccounts, runGog, runGogJson } from '../tools/gog.js';

export interface ToolSurfaceInputs {
  home: MeridianHome;
  config: AgentConfig;
  env: AgentEnv;
  cortex: CortexBind;
  logger: Logger;
  /** Skip MCP connections (e.g. `meridian mcp serve` must not recursively
   *  dial out, and tests that don't care about MCP stay hermetic). */
  skipMcp?: boolean;
}

export interface ToolSurface {
  /** Merged ToolSet: builtins + skill dynamic tools + MCP tools. */
  tools: ToolSet;
  /** Names from v2 skills — auto-allowed on every channel. */
  skillToolNames: Set<string>;
  /** MCP toolName → channels allowed to see it (TurnContext.mcpGate). */
  mcpGate: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per-server MCP connection status for doctor / `meridian mcp list`. */
  mcpStatus: McpToolSurface['status'];
  skills: SkillRegistry;
  vault: Vault;
  guard: PassphraseGuard;
  builtinToolNames: string[];
  /** Release held resources (MCP connections). Idempotent. */
  close(): Promise<void>;
}

export async function buildToolSurface(inputs: ToolSurfaceInputs): Promise<ToolSurface> {
  const { home, env, cortex, logger } = inputs;

  const builtin = builtinTools({ cortex, env });

  // Skills v2: open the encrypted vault, build a SkillToolContext, and let
  // the loader instantiate any tools.ts-defined tools. Skill manifests
  // declare their env requirements; prescan + merge those keys from
  // process.env onto the typed AgentEnv (loose at runtime by design).
  const vault = openAgentVault({ envPath: home.envPath, vaultPath: home.vaultPath });
  const guard = new PassphraseGuard(vault);
  const mergedEnv = Object.assign({}, env, collectSkillEnv(prescanManifestEnvKeys(home))) as typeof env;

  const skillCtx = {
    cortex,
    vault,
    env: mergedEnv,
    logger,
    requirePassphrase: (skillName: string, candidate?: string) =>
      guard.require(skillName, candidate),
    hashPassphrase: (raw: string) => PassphraseGuard.hash(raw),
    grantPassphraseSession: (skillName: string, windowMinutes?: number) =>
      guard.grant(skillName, windowMinutes ?? 30),
    tool: aiTool,
    z: zod,
    tools: {
      gog: { run: runGog, runJson: runGogJson, listAccounts: gogListAccounts },
    },
  };
  const skills = await loadSkills(home, { ctx: skillCtx });
  const skillToolNames = new Set<string>();
  for (const s of skills.list()) {
    if (s.dynamicTools) for (const k of Object.keys(s.dynamicTools)) skillToolNames.add(k);
  }

  // MCP: CONNECTIONS/mcp.json servers → channel-gated first-class tools.
  let mcp: McpToolSurface = {
    tools: {},
    channelGate: new Map(),
    status: [],
    close: async () => {},
  };
  if (!inputs.skipMcp) {
    try {
      const servers = loadMcpConnections(home);
      if (servers.length > 0) {
        mcp = await connectMcpServers(servers, logger);
      }
    } catch (err) {
      // Malformed mcp.json: loud in the log, but an agent that booted
      // yesterday still boots today.
      logger.warn({ msg: 'mcp connections skipped', err: (err as Error).message });
    }
  }

  return {
    tools: { ...builtin, ...skills.asTools(), ...mcp.tools },
    skillToolNames,
    mcpGate: mcp.channelGate,
    mcpStatus: mcp.status,
    skills,
    vault,
    guard,
    builtinToolNames: Object.keys(builtin),
    close: mcp.close,
  };
}
