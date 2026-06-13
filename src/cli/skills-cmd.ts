/**
 * `meridian skills` — list, install, and remove skills on an agent.
 *
 * v0.7 MVP: a curated set of real, working SKILL.md files lives in the
 * meridian package under `skeleton/skills/<name>/SKILL.md`. `install`
 * copies the manifest into the agent's `SKILLS/<name>/` layer; the loader
 * picks it up on next boot and the agent gains the new capability.
 *
 * `remove` deletes the agent-side copy. The catalog stays available so
 * the operator can re-install or browse alternatives.
 */

import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { activeAgentSlug, ensureAgentHome, loadAgentConfig } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { ProviderRouter } from '../providers/router.js';
import { generateSkillDraft, installSkillDraft, screenSkillDraft } from '../skills/authoring.js';
import { colors } from '../utils/truecolor.js';
import type { Vault } from '../secrets/vault.js';
import type { GogRunOptions, GogRunResult } from '../tools/gog.js';

/**
 * Context handed to a skill's `setup(ctx)` export. Stable surface — skills
 * import nothing from meridian internals; they get everything through this.
 */
export interface SetupCtx {
  vault: Vault;
  env: Record<string, string | undefined>;
  agentSlug: string;
  prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  err: (msg: string) => void;
  tools: {
    gog: {
      run: (opts: GogRunOptions) => Promise<GogRunResult>;
      runJson: <T = unknown>(opts: GogRunOptions) => Promise<T>;
      listAccounts: (
        client: string,
      ) => Promise<Array<{ email: string; client: string; scopes: string; expires?: string; type: string }>>;
      /** Spawn `gog auth login <email> --client <bucket>` with inherited
       *  stdio so the operator sees the OAuth URL gog prints and gets
       *  prompted by gog directly. Returns the gog exit code. */
      spawnLogin: (email: string, client: string) => Promise<number>;
    };
  };
}

/**
 * Prompt the operator once. With `mask: true`, echoes '*' per char so a
 * pasted API key isn't shoulder-surfable. Falls back to plain readline
 * when stdin isn't a TTY (CI, piped input).
 */
async function promptOnce(
  question: string,
  opts?: { mask?: boolean },
): Promise<string> {
  if (opts?.mask && process.stdin.isTTY) {
    return await maskedPrompt(question);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}

async function maskedPrompt(question: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    process.stdout.write(`${question} `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('aborted'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    stdin.on('data', onData);
  });
}

function packageRoot(): string {
  // Resolve the meridian package root (where /skeleton lives) regardless
  // of whether we run from /src or /dist.
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/skills-cmd.ts → ../../  =  package root
  return join(here, '..', '..');
}

function catalogDir(): string {
  // Try uppercase first (canonical seven-layer convention) then lowercase
  // for case-sensitive filesystems where both spellings might exist.
  const upper = join(packageRoot(), 'skeleton', 'SKILLS');
  if (existsSync(upper)) return upper;
  return join(packageRoot(), 'skeleton', 'skills');
}

function listCatalog(): string[] {
  const dir = catalogDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() && existsSync(join(full, 'SKILL.md'));
  });
}

function listInstalled(home: ReturnType<typeof ensureAgentHome>): string[] {
  const dir = home.layer('SKILLS');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() && existsSync(join(full, 'SKILL.md'));
  });
}

export function runSkillsList(): void {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const installed = new Set(listInstalled(home));
  const catalog = listCatalog();
  console.log(colors.cyan(`Skills · agent ${slug}`));
  console.log('');
  if (installed.size > 0) {
    console.log(colors.cyan('  Installed'));
    for (const name of [...installed].sort()) {
      console.log(`    ${colors.ok('●')}  ${name}`);
    }
    console.log('');
  }
  if (catalog.length > 0) {
    console.log(colors.cyan('  Catalog (installable)'));
    for (const name of catalog.sort()) {
      const tag = installed.has(name) ? colors.muted('[installed]') : colors.muted('available');
      console.log(`    ${colors.muted('·')}  ${name}  ${tag}`);
    }
  } else {
    console.log(colors.muted('  catalog is empty'));
  }
}

export function runSkillsInstall(name: string): void {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const src = join(catalogDir(), name, 'SKILL.md');
  if (!existsSync(src)) {
    console.error(colors.err(`skill "${name}" not found in catalog`));
    console.error(colors.muted(`  catalog: ${catalogDir()}`));
    process.exit(1);
  }
  const dstDir = join(home.layer('SKILLS'), name);
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(src, join(dstDir, 'SKILL.md'));
  // Copy any sibling assets (templates, helpers) the skill ships with.
  const srcDir = join(catalogDir(), name);
  for (const entry of readdirSync(srcDir)) {
    if (entry === 'SKILL.md') continue;
    const sub = join(srcDir, entry);
    if (statSync(sub).isFile()) {
      copyFileSync(sub, join(dstDir, entry));
    }
  }
  console.log(colors.ok(`installed ${name} → ${dstDir}`));
  console.log(
    colors.muted('  restart the gateway (or REPL) for the agent to load it.'),
  );
}

export function runSkillsRemove(name: string): void {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const dst = join(home.layer('SKILLS'), name);
  if (!existsSync(dst)) {
    console.error(colors.err(`skill "${name}" is not installed on ${slug}`));
    process.exit(1);
  }
  rmSync(dst, { recursive: true, force: true });
  console.log(colors.ok(`removed ${name}`));
}

/**
 * `meridian skills setup <name>` — interactive walkthrough that:
 *   1. Reads the skill's manifest.yaml
 *   2. For each declared `requires.env` key: tells the operator to add it
 *   3. For passphrase-required skills: prompts for passphrase, hashes it,
 *      writes to the agent's encrypted vault
 *   4. For OAuth skills: launches the OAuth flow (delegated to provider-
 *      specific helper)
 *   5. Prints the setup.md walkthrough body if present
 */
export async function runSkillsSetup(name: string): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);

  const installed = join(home.layer('SKILLS'), name);
  if (!existsSync(installed)) {
    console.error(
      colors.err(
        `skill "${name}" is not installed on ${slug}. run \`meridian skills install ${name}\` first.`,
      ),
    );
    process.exit(1);
  }

  const manifestPath = join(installed, 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    console.log(
      colors.warn(
        `skill "${name}" has no manifest.yaml — it may be a legacy markdown-only skill with no setup required.`,
      ),
    );
    process.exit(0);
  }

  const { parse: parseYaml } = await import('yaml');
  const { SkillManifestV2Schema } = await import('../config/schema.js');
  const manifest = SkillManifestV2Schema.parse(parseYaml(readFileSync(manifestPath, 'utf8')));

  console.log(colors.cyan(`Setup: ${manifest.name}`));
  console.log(colors.muted(`  ${manifest.description}`));
  console.log('');

  // Print the human-readable walkthrough first if present.
  if (manifest.setup) {
    const walkthroughPath = join(installed, manifest.setup);
    if (existsSync(walkthroughPath)) {
      console.log(colors.muted('--- walkthrough ---'));
      console.log(readFileSync(walkthroughPath, 'utf8'));
      console.log(colors.muted('--- end walkthrough ---'));
      console.log('');
    }
  }

  // Env requirements: just check + tell operator (we don't write to .env
  // automatically — the operator does that themselves to keep the .env
  // editing flow explicit).
  const { readEnvFile } = await import('../config/loader.js');
  const env = readEnvFile(home.envPath);
  const missingEnv = manifest.requires.env.filter((k) => !env[k]);
  if (missingEnv.length > 0) {
    console.log(colors.warn('Missing env keys:'));
    for (const k of missingEnv) {
      console.log(colors.muted(`  ${k}`));
    }
    console.log(colors.muted(`  add to ${home.envPath} and re-run setup`));
    console.log('');
  } else if (manifest.requires.env.length > 0) {
    console.log(colors.ok(`env keys present: ${manifest.requires.env.join(', ')}`));
  }

  // Vault: open it (creates MERIDIAN_VAULT_KEY in .env if missing).
  const { openAgentVault } = await import('../secrets/vault.js');
  const vault = openAgentVault({ envPath: home.envPath, vaultPath: home.vaultPath });

  // ── Per-skill setup() hook ──
  // If the skill's tools.ts exports a `setup(ctx)` function, run it.
  // This is how skills with non-standard requirements (OAuth flows,
  // multi-step credentials, third-party verification) drive their own
  // walkthrough without us hardcoding per-skill logic in the runner.
  const toolsTs = join(installed, 'tools.ts');
  if (existsSync(toolsTs)) {
    try {
      const {
        runGog,
        runGogJson,
        listAccounts: gogListAccounts,
        resolveGog,
      } = await import('../tools/gog.js');
      const { spawn } = await import('node:child_process');
      const { pathToFileURL } = await import('node:url');
      const mod = (await import(pathToFileURL(toolsTs).href)) as {
        setup?: (ctx: SetupCtx) => Promise<void>;
      };
      if (typeof mod.setup === 'function') {
        const setupCtx: SetupCtx = {
          vault,
          env,
          agentSlug: slug,
          prompt: (q, opts) => promptOnce(`  ${q}`, opts),
          log: (msg) => console.log(colors.muted(`  ${msg}`)),
          warn: (msg) => console.log(colors.warn(`  ${msg}`)),
          err: (msg) => console.log(colors.err(`  ${msg}`)),
          tools: {
            gog: {
              run: runGog,
              runJson: runGogJson,
              listAccounts: gogListAccounts,
              spawnLogin: async (email, client) => {
                const bin = await resolveGog({ allowPathFallback: true });
                return await new Promise<number>((resolve, reject) => {
                  const proc = spawn(bin, ['auth', 'login', email, '--client', client], {
                    stdio: 'inherit',
                  });
                  proc.on('exit', (code) => resolve(code ?? -1));
                  proc.on('error', reject);
                });
              },
            },
          },
        };
        await mod.setup(setupCtx);
      }
    } catch (err) {
      console.log(colors.err(`  setup() failed: ${(err as Error).message}`));
      process.exit(1);
    }
  }

  // Passphrase setup if required.
  if (manifest.passphrase?.required) {
    const { PassphraseGuard } = await import('../skills/runtime.js');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(
      colors.cyan(
        `Set the passphrase for ${manifest.name}. Anyone (or any compromised agent) without this phrase cannot trigger ${manifest.name} actions.`,
      ),
    );
    const phrase1 = (await rl.question('  passphrase: ')).trim();
    if (phrase1.length < 4) {
      console.log(colors.err('passphrase too short (min 4 chars)'));
      rl.close();
      process.exit(1);
    }
    const phrase2 = (await rl.question('  confirm:    ')).trim();
    if (phrase1 !== phrase2) {
      console.log(colors.err('passphrases did not match'));
      rl.close();
      process.exit(1);
    }
    rl.close();
    const guard = new PassphraseGuard(vault);
    guard.setPassphrase(manifest.name, phrase1);
    console.log(colors.ok(`  passphrase set (sha256, stored in encrypted vault)`));
    console.log(
      colors.muted(
        `  session window: ${manifest.passphrase.sessionWindowMinutes} min` +
          (manifest.passphrase.sessionWindowConfigurable
            ? ' (configurable per call via ctx.grantPassphraseSession)'
            : ''),
      ),
    );
  }

  console.log('');
  console.log(colors.ok(`${manifest.name} configured.`));
  console.log(colors.muted(`  restart the gateway (or REPL) for the skill's tools to load.`));
}

/**
 * `meridian skills new --description "..."` — author a new MARKDOWN skill from a
 * description (and optional context), SCREEN it through the memory-poisoning
 * defense, and install it. A poisoned description that tries to smuggle a
 * malicious instruction (override / sensitive-bypass / exfiltration / secret
 * disclosure) is BLOCKED before anything is written.
 */
export async function runSkillNew(
  description: string,
  opts: { context?: string; overwrite?: boolean } = {},
): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const config = loadAgentConfig(home);
  const env = loadAgentEnv(home);
  const router = new ProviderRouter(env);

  console.log(colors.cyan('Authoring a skill from your description…'));
  let draft: Awaited<ReturnType<typeof generateSkillDraft>>;
  try {
    draft = await generateSkillDraft(description, opts.context, { router, models: config.models });
  } catch (err) {
    console.error(colors.err(`could not author the skill: ${(err as Error).message}`));
    process.exit(1);
  }

  // The moat: screen the generated skill BEFORE writing it.
  const screen = screenSkillDraft(draft);
  if (!screen.ok) {
    console.error(colors.err('\n🛡️  BLOCKED by the memory-poisoning defense.'));
    console.error(colors.err(`   ${screen.reason}`));
    console.error(colors.muted(`   signals: ${screen.flags.join(', ')}`));
    console.error(colors.muted('   Nothing was written. A safe skill is never installed without passing this screen.'));
    process.exit(2);
  }

  try {
    const { slug: skillSlug, dir } = installSkillDraft(draft, home, { overwrite: opts.overwrite });
    console.log(colors.ok(`\n✓ authored + screened + installed: ${skillSlug}`));
    console.log(colors.muted(`  ${dir}`));
    console.log(colors.muted(`  description: ${draft.description}`));
    console.log(colors.muted('  restart the gateway (or REPL) for the agent to load it.'));
  } catch (err) {
    console.error(colors.err((err as Error).message));
    process.exit(1);
  }
}
