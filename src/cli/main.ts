/**
 * `meridian` CLI entry. Commander-based subcommand tree.
 *
 *   meridian              → start REPL with active agent
 *   meridian init <name>  → seed a new agent home (seven-layer scaffold)
 *   meridian agents       → list known agents
 *   meridian use <name>   → switch active agent
 *   meridian doctor       → end-to-end health check
 *   meridian deploy       → run the 20-min provisioning pipeline from intake JSON
 *   meridian audit        → run the AgentOS retrospective
 *   meridian gateway      → start HTTP gateway + channels
 */

// Suppress deprecation noise (e.g. node 22's punycode whine from a transitive
// dep). User-facing CLIs don't get to spew node internals over the boot screen.
process.removeAllListeners('warning');

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { activeAgentSlug, ensureAgentHome, listAgents, loadAgentConfig, setActiveAgent } from '../config/home.js';
import { loadAgentEnv, envFileTemplate } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { createMemoryProvider } from '../memory/index.js';
import { ProviderRouter } from '../providers/router.js';
import { Conversation } from '../agent/conversation.js';
import { DreamWeaver } from '../dream/weaver.js';
import { buildToolSurface } from '../agent/tool-surface.js';
import { createLogger } from '../logger/pino.js';
import { SessionStore } from '../session/store.js';
import { runRepl } from './repl.js';
import { runAudit, writeReport, renderReport } from '../audit/retrospective.js';
import { colors } from '../utils/truecolor.js';
import { runDoctor } from './doctor.js';
import { runDeploy } from '../deploy/pipeline.js';
import { runGateway } from './gateway-cmd.js';
import { initAgent } from './init-cmd.js';
import { runOnboard } from './onboard-cmd.js';
import { pickAgentInteractive } from './agent-picker.js';
import { runSkillsList, runSkillsInstall, runSkillsRemove, runSkillsSetup, runSkillNew } from './skills-cmd.js';
import { runIngest } from './ingest-cmd.js';
import { runVoicePassphrase, runVoiceStatus, runVoiceCall } from './voice-cmd.js';
import { runMcpAdd, runMcpList, runMcpRemove, runMcpServe, runMcpToggle } from './mcp-cmd.js';
import { runDemo } from './demo-cmd.js';
import { runImport } from './import-cmd.js';

// Read the real version from package.json so `--version` never drifts from the
// published release. `../../package.json` resolves the same from src/cli (tsx
// dev) and dist/cli (built) since both sit two levels under the package root.
function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();
program
  .name('meridian')
  .description('Meridian: the cognitive agent runtime by ATERNA AI')
  .version(packageVersion());

program
  .option('-a, --agent <slug>', 'agent slug (overrides MERIDIAN_AGENT env)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts<{ agent?: string }>();
    if (opts.agent) process.env.MERIDIAN_AGENT = opts.agent;
  });

program
  .command('init <slug>')
  .option('--no-guided', 'skip the guided Q&A intake (use defaults)')
  .description('Initialize a new agent home with the seven-layer AgentOS scaffold')
  .option('--template <name>', 'starter template (frontdesk | receptionist | sales | concierge)')
  .option('--inherits <slug>', 'inherit CONTEXT, MEMORY, CONNECTIONS from a hub agent')
  .option('--embedded', 'force zero-config local memory (the default unless CORTEX creds are present)')
  .option('--cortex', 'provision for the CORTEX server path (needs NEON_DATABASE_URL + VOYAGE_API_KEY)')
  .action(
    async (
      slug: string,
      opts: {
        template?: string;
        inherits?: string;
        guided?: boolean;
        embedded?: boolean;
        cortex?: boolean;
      },
    ) => {
      await initAgent(slug, opts);
    },
  );

program
  .command('onboard')
  .description('Run the extended onboarding interview to populate IDENTITY/USER.md and CONTEXT/* files')
  .action(async () => {
    await runOnboard();
  });

program
  .command('agents')
  .description('List configured agents')
  .action(() => {
    const agents = listAgents();
    if (!agents.length) {
      console.log(colors.muted('No agents yet. Run `meridian init <name>`.'));
      return;
    }
    let active: string | undefined;
    try {
      active = activeAgentSlug();
    } catch {
      // none active
    }
    for (const a of agents) {
      const marker = a === active ? colors.cyan('●') : colors.muted('○');
      console.log(`  ${marker} ${a}`);
    }
  });

program
  .command('use <slug>')
  .description('Switch active agent')
  .action((slug: string) => {
    setActiveAgent(slug);
    console.log(colors.ok(`active agent: ${slug}`));
  });

program
  .command('demo')
  .description('90-second proof: persistent memory + memory-poisoning defense, zero setup')
  .action(async () => {
    await runDemo();
  });

const mcp = program.command('mcp').description('Model Context Protocol — consume servers, or serve this agent');
mcp
  .command('list')
  .description('Probe MCP servers declared in CONNECTIONS/mcp.json and list their tools')
  .action(async () => {
    process.exit(await runMcpList());
  });
mcp
  .command('add <name>')
  .description('Register an MCP server in CONNECTIONS/mcp.json (no hand-editing JSON)')
  .option('--transport <kind>', 'stdio | http | sse', 'stdio')
  .option('--command <cmd>', 'stdio: the executable to launch (e.g. npx)')
  .option('--arg <value>', 'stdio: a command argument (repeatable)', (v: string, acc: string[]) => {
    acc.push(v);
    return acc;
  }, [] as string[])
  .option('--url <url>', 'http/sse: the server endpoint URL')
  .option('--channels <list>', 'comma-separated channels that may see the tools (default cli)')
  .option('--force', 'overwrite an existing server of the same name')
  .action(
    async (
      name: string,
      opts: {
        transport?: 'stdio' | 'http' | 'sse';
        command?: string;
        arg?: string[];
        url?: string;
        channels?: string;
        force?: boolean;
      },
    ) => {
      process.exit(
        await runMcpAdd({
          name,
          transport: opts.transport,
          command: opts.command,
          args: opts.arg,
          url: opts.url,
          channels: opts.channels?.split(',').map((c) => c.trim()).filter(Boolean),
          force: opts.force,
        }),
      );
    },
  );
mcp
  .command('remove <name>')
  .description('Remove an MCP server from CONNECTIONS/mcp.json')
  .action(async (name: string) => {
    process.exit(await runMcpRemove(name));
  });
mcp
  .command('enable <name>')
  .description('Enable a server (its tools load) without changing its config')
  .action(async (name: string) => {
    process.exit(await runMcpToggle(name, true));
  });
mcp
  .command('disable <name>')
  .description('Disable a server (keeps its config, stops loading its tools)')
  .action(async (name: string) => {
    process.exit(await runMcpToggle(name, false));
  });
mcp
  .command('serve')
  .description('Expose this agent over MCP on stdio (CORTEX recall as a tool)')
  .option('--allow-encode', 'also expose memory_encode (write access)')
  .action(async (opts: { allowEncode?: boolean }) => {
    await runMcpServe(opts);
  });

program
  .command('doctor')
  .description('Run end-to-end health checks across the AgentOS')
  .action(async () => {
    const exit = await runDoctor();
    process.exit(exit);
  });

program
  .command('deploy')
  .description('Run the 20-minute provisioning pipeline from an intake.json')
  .requiredOption('--intake <path>', 'path to intake JSON answers')
  .option('--allow-write', 'permit write-mode connections (default read-only)')
  .action(async (opts: { intake: string; allowWrite?: boolean }) => {
    await runDeploy(opts);
  });

program
  .command('audit')
  .description('Run the AgentOS retrospective and write a markdown report')
  .option('--print', 'print the report to stdout in addition to writing to disk')
  .action((opts: { print?: boolean }) => {
    const slug = activeAgentSlug();
    const home = ensureAgentHome(slug);
    const report = runAudit(home);
    const path = writeReport(home, report);
    console.log(colors.ok(`audit written to ${path}`));
    if (opts.print) console.log(`\n${renderReport(report)}`);
  });

program
  .command('gateway')
  .description('Start the HTTP gateway + configured channels for the active agent')
  .option('--port <port>', 'override gateway port', (v) => parseInt(v, 10))
  .option('--web', 'serve the bundled web chat UI at / (same-origin autoconfig)')
  .action(async (opts: { port?: number; web?: boolean }) => {
    await runGateway(opts);
  });

// `meridian ingest <path>` — feed a file (or directory) into CORTEX.
program
  .command('ingest <path>')
  .description('Ingest a file (text, markdown, PDF, image, audio) into the active agent\'s CORTEX')
  .action(async (path: string) => {
    await runIngest(path);
  });

// `meridian import <openclaw|hermes>` — migrate a competitor agent home into a
// Meridian seven-layer home (secrets surfaced, never imported).
program
  .command('import <source>')
  .description('Migrate an OpenClaw or Hermes agent home into Meridian (source: openclaw | hermes)')
  .option('--from <path>', 'source home directory (default ~/.openclaw or ~/.hermes)')
  .option('--slug <name>', 'target Meridian agent slug (default <source>-import)')
  .option('--cortex', 'use the full CORTEX backend instead of zero-config embedded memory')
  .option('--overwrite', 'overwrite an existing agent home of the same slug')
  .option('--dry-run', 'preview the import without writing anything')
  .option('--sessions', 'also copy raw session transcripts (JSONL) — they can run 50-160MB')
  .option('--no-systemd', 'skip scanning systemd units for the source home\'s env var names')
  .action(
    async (
      source: string,
      opts: {
        from?: string;
        slug?: string;
        cortex?: boolean;
        overwrite?: boolean;
        dryRun?: boolean;
        sessions?: boolean;
        systemd?: boolean;
      },
    ) => {
      await runImport(source, opts);
    },
  );

// `meridian voice` — manage voice-channel configuration (passphrase unlock).
const voiceCmd = program
  .command('voice')
  .description('Manage voice-channel configuration for the active agent');
voiceCmd
  .command('passphrase')
  .description('Set or rotate the voice unlock passphrase (gates privileged voice tools)')
  .option('--clear', 'remove the passphrase (privileged voice tools become unreachable)')
  .action(async (opts: { clear?: boolean }) => {
    await runVoicePassphrase(opts);
  });
voiceCmd
  .command('status')
  .description('Show whether a voice passphrase is configured')
  .action(() => runVoiceStatus());
voiceCmd
  .command('call <to>')
  .description('Place an outbound voice call to an E.164 number (requires the gateway to be running)')
  .option('--first-message <text>', 'override the assistant\'s opening line for this call')
  .option('--customer-name <name>', 'pass a name to the assistant for personalized greetings')
  .action(async (to: string, opts: { firstMessage?: string; customerName?: string }) => {
    await runVoiceCall({ to, firstMessage: opts.firstMessage, customerName: opts.customerName });
  });

// `meridian skills` — list / install / remove skill manifests.
const skillsCmd = program
  .command('skills')
  .description('Manage installed skills for the active agent');
skillsCmd
  .command('list')
  .description('List installed and catalog skills')
  .action(() => runSkillsList());
skillsCmd
  .command('install <name>')
  .description('Install a skill from the catalog into the active agent')
  .action((name: string) => runSkillsInstall(name));
skillsCmd
  .command('remove <name>')
  .description('Remove an installed skill from the active agent')
  .action((name: string) => runSkillsRemove(name));
skillsCmd
  .command('setup <name>')
  .description('Run a skill\'s interactive setup walkthrough (env keys, passphrase, OAuth, etc.)')
  .action(async (name: string) => {
    await runSkillsSetup(name);
  });
skillsCmd
  .command('new')
  .description('Author a NEW markdown skill from a description — screened by the memory-poisoning defense before install')
  .requiredOption('--description <text>', 'what the skill should do')
  .option('--context <text>', 'optional experience/context to encode into the skill')
  .option('--overwrite', 'overwrite an existing skill of the same name')
  .action(async (opts: { description: string; context?: string; overwrite?: boolean }) => {
    await runSkillNew(opts.description, { context: opts.context, overwrite: opts.overwrite });
  });

program
  .command('chat', { isDefault: true })
  .description('Open the interactive REPL for the active agent')
  .action(async () => {
    await openChat();
  });

async function openChat(): Promise<void> {
  // Agent resolution order:
  //   1. --agent <slug> on the CLI (sets MERIDIAN_AGENT before this runs)
  //   2. MERIDIAN_AGENT env var (set by the per-agent shortcuts in /usr/local/bin)
  //   3. Interactive picker — always asks; no silent default — agent
  //      UX rule. On a fresh install with one agent, picker still shows so
  //      identity is explicit.
  const slug = await pickAgentInteractive(process.env.MERIDIAN_AGENT);
  const home = ensureAgentHome(slug);
  const config = loadAgentConfig(home);
  const logger = createLogger({ home });

  // .env existence check
  if (!existsSync(home.envPath)) {
    writeFileSync(home.envPath, envFileTemplate(slug));
    console.log(
      colors.warn(
        `\nWrote ${home.envPath}. Fill in NEON_DATABASE_URL, VOYAGE_API_KEY, and at least one model provider key, then re-run.`,
      ),
    );
    process.exit(1);
  }

  let env: ReturnType<typeof loadAgentEnv>;
  try {
    env = loadAgentEnv(home);
  } catch (err) {
    console.log(colors.err(`config error: ${(err as Error).message}`));
    process.exit(1);
  }

  const cortex = bindCortex(env.CORTEX_AGENT_ID, env.MERIDIAN_CORTEX_URL);
  const router = new ProviderRouter(env);

  // Memory provider seam (Phase 3a/3b/4). The conversation turn loop reads
  // `memorySelection.provider`; everything else (encode, dream, sentinel,
  // skills) still talks to `cortex` directly. Encode and dream are identical
  // through both providers (Quartz delegates them to CortexBind), so leaving
  // them on the concrete bind costs nothing today and keeps the migration
  // surgical.
  const memorySelection = await createMemoryProvider({
    env,
    router,
    cortex,
    embeddedDbPath: join(home.layer('MEMORY'), 'embedded.jsonl'),
    log: (level, msg) => {
      if (level === 'warn') console.log(colors.warn(`! ${msg}`));
      else logger.info({ event: 'memory.provider.selected', msg }, msg);
    },
  });

  // Tool surface: builtins + v2 skill tools + MCP tools, assembled in one
  // place shared with the gateway (src/agent/tool-surface.ts).
  const surface = await buildToolSurface({ home, config, env, cortex, logger, router, memory: memorySelection.provider });
  const { tools, skillToolNames, skills, guard, verificationChecks, provenanceSigner } = surface;

  // ── Runtime loadout — regenerate at every REPL boot ──
  // Auto-writes a CONTEXT file with current channels, automations, skills,
  // tools. Loaded into the system prompt every turn, so the agent always
  // knows what it can do.
  try {
    const { writeLoadoutFile } = await import('../agent/loadout.js');
    const { loadAutomationDefs } = await import('../automations/manager.js');
    const cortexStats = await cortex.stats().catch(() => undefined);
    writeLoadoutFile({
      home,
      config,
      env,
      skills,
      automations: loadAutomationDefs(home),
      builtinToolNames: surface.builtinToolNames,
      mcpTools: surface.mcpStatus.flatMap((st) => st.tools.map((t) => ({ name: t, server: st.server }))),
      cortexStats: cortexStats ?? undefined,
    });
  } catch (err) {
    logger.warn({ msg: 'loadout write failed (repl)', err });
  }
  const store = new SessionStore(home);
  // Hand the conversation the active memory provider — CortexBind by default,
  // QuartzMemoryProvider when MERIDIAN_MEMORY_PROVIDER=quartz lit up at boot.
  // Every subsequent recall on this turn loop now flows through Quartz when
  // selected; encode + dream + sentinel still use CortexBind directly because
  // those paths have not been migrated yet (see follow-up: memory/provider
  // surface migration).
  const conversation = new Conversation({
    config,
    cortex: memorySelection.provider,
    router,
    logger,
    systemBase: '',
    channel: 'cli',
    tools,
    skillToolNames,
    mcpGate: surface.mcpGate,
    verificationChecks,
    provenanceSigner,
    store,
  });
  // DreamWeaver consolidates CORTEX memory; the embedded provider has no
  // consolidation pipeline, so skip it in zero-config mode.
  const dream = new DreamWeaver({ cortex, config: config.dream, logger });
  if (memorySelection.selected !== 'embedded') dream.start();

  store.startSession(conversation.snapshot());
  let turnIdx = 0;
  const origSend = conversation.send.bind(conversation);
  conversation.send = async (input, sendOpts) => {
    const turn = await origSend(input, sendOpts);
    store.appendTurn({ ...turn, role: 'user', content: input }, turnIdx++);
    store.appendTurn(turn, turnIdx++);
    return turn;
  };

  await runRepl({ home, config, conversation, cortex, dream, skills, store, passphraseGuard: guard });
  dream.stop();
  store.close();
  await surface.close();
}

program.parseAsync(process.argv).catch((err) => {
  console.error(colors.err(`fatal: ${(err as Error).message}`));
  process.exit(1);
});
