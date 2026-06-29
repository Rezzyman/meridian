/**
 * `meridian init <slug>` — seed a new agent home with the seven-layer
 * AgentOS scaffold. Optional --template seeds a starter (Chief of Staff,
 * receptionist, etc). Optional --inherits points at a hub agent and
 * symlinks shared CONTEXT/MEMORY/CONNECTIONS dirs.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ensureAgentHome, resolveHome, setActiveAgent } from '../config/home.js';
import { defaultAgentConfig } from '../config/schema.js';
import { envFileTemplate, embeddedEnvFileTemplate } from '../config/loader.js';
import { colors } from '../utils/truecolor.js';

const here = dirname(fileURLToPath(import.meta.url));
// Repo skeleton lives at <repo>/skeleton; from src/cli/ that is ../../skeleton
const SKELETON_ROOT = resolve(here, '../../skeleton');
const TEMPLATES_ROOT = resolve(SKELETON_ROOT, 'templates');

export interface InitOptions {
  template?: string;
  inherits?: string;
  guided?: boolean;
  embedded?: boolean;
}

function copyDirRecursive(from: string, to: string, overwrite = false): void {
  if (!existsSync(from)) return;
  if (!existsSync(to)) mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const f = join(from, entry);
    const t = join(to, entry);
    if (statSync(f).isDirectory()) copyDirRecursive(f, t, overwrite);
    else if (overwrite || !existsSync(t)) copyFileSync(f, t);
  }
}

export async function initAgent(slug: string, opts: InitOptions): Promise<void> {
  const home = ensureAgentHome(slug);
  console.log(colors.cyan(`Initializing Meridian agent: ${slug}`));
  console.log(colors.muted(`  home: ${home.agentRoot}`));

  // Default config
  const config = defaultAgentConfig(slug, slug);
  if (opts.template) config.agent.template = opts.template;
  if (opts.inherits) config.agent.inheritsFrom = opts.inherits;
  if (!existsSync(home.configPath)) {
    writeFileSync(home.configPath, stringifyYaml(config));
  }

  // .env template — embedded mode writes a zero-config env (no Neon/Voyage,
  // local memory, ollama default) so the agent runs with no external setup.
  if (!existsSync(home.envPath)) {
    writeFileSync(home.envPath, opts.embedded ? embeddedEnvFileTemplate(slug) : envFileTemplate(slug));
  }

  // Copy skeleton seven-layer files
  const LAYERS = [
    'IDENTITY',
    'CONTEXT',
    'SKILLS',
    'MEMORY',
    'CONNECTIONS',
    'VERIFICATION',
    'AUTOMATIONS',
  ] as const;
  if (existsSync(SKELETON_ROOT)) {
    for (const layer of LAYERS) {
      copyDirRecursive(join(SKELETON_ROOT, layer), home.layer(layer));
    }
  }

  // Apply template if specified (accept both snake_case and kebab-case)
  if (opts.template) {
    const candidates = [opts.template, opts.template.replace(/_/g, '-'), opts.template.replace(/-/g, '_')];
    const found = candidates.find((c) => existsSync(join(TEMPLATES_ROOT, c)));
    if (found) {
      copyDirRecursive(join(TEMPLATES_ROOT, found), home.agentRoot, true);
      console.log(colors.ok(`  applied template: ${found}`));
    } else {
      console.log(colors.warn(`  template not found: ${opts.template}`));
    }
  }

  // Inheritance: symlink hub layers
  if (opts.inherits) {
    const hub = resolveHome(opts.inherits);
    if (!existsSync(hub.agentRoot)) {
      console.log(colors.err(`  hub agent not found: ${opts.inherits}`));
    } else {
      const inheritLayers = ['CONTEXT', 'MEMORY', 'CONNECTIONS'] as const;
      for (const layer of inheritLayers) {
        const target = home.layer(layer);
        const source = hub.layer(layer);
        try {
          // Remove the empty dir before symlink
          if (existsSync(target)) {
            const entries = readdirSync(target);
            if (entries.length === 0) {
              rmdirSync(target);
            } else {
              continue;
            }
          }
          symlinkSync(source, target, 'dir');
          console.log(colors.ok(`  inherited ${layer} from ${opts.inherits}`));
        } catch (err) {
          console.log(colors.warn(`  could not symlink ${layer}: ${(err as Error).message}`));
        }
      }
    }
  }

  setActiveAgent(slug);

  // Optional guided intake — Q&A that writes a coherent IDENTITY/AGENT.md
  // and operator block instead of leaving empty placeholders. The default
  // for new agents; opt out with --no-guided.
  if (opts.guided !== false) {
    const { runGuidedInit } = await import('./init-guided.js');
    await runGuidedInit(slug, home);
  }

  console.log(colors.ok(`\nMeridian agent '${slug}' ready.`));
  console.log(colors.muted('Next steps:'));
  console.log(colors.muted(`  1. Add a model key to ${home.envPath}:`));
  console.log(
    colors.muted('       • ROUTEXOR (default — BYOK, zero markup): free key at https://routexor.com → ROUTEXOR_API_KEY'),
  );
  console.log(
    colors.muted('       • or a direct provider key (ANTHROPIC/OPENAI/GROQ), or a local `ollama` model (no key)'),
  );
  console.log(colors.muted('     (full CORTEX memory also needs NEON_DATABASE_URL + VOYAGE_API_KEY)'));
  console.log(colors.muted('  2. Run `meridian doctor` to validate the wiring.'));
  console.log(colors.muted('  3. Run `meridian onboard` for the extended interview (mission, stakeholders, principles).'));
  console.log(colors.muted('  4. Run `meridian` to start chatting.'));
}
