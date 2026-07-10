/**
 * `meridian ingest <path>` — feed a file into the active agent's CORTEX.
 *
 * Supports text, markdown, and PDF (full extraction). Images and audio
 * are encoded as stubs (multimodal embeddings are v0.2). Reports per-file
 * landing summary so the operator can see what got remembered.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeAgentSlug, ensureAgentHome, loadAgentConfig } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { createMemoryProvider } from '../memory/index.js';
import { ingestFile, type IngestOptions } from '../ingest/file-ingest.js';
import { ProviderRouter } from '../providers/router.js';
import { analyzeImage } from '../vision/analyze.js';
import { colors } from '../utils/truecolor.js';

export async function runIngest(path: string): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const config = loadAgentConfig(home);
  const env = loadAgentEnv(home);
  const cortex = bindCortex(env.CORTEX_AGENT_ID, env.MERIDIAN_CORTEX_URL);
  const router = new ProviderRouter(env);
  // Encode through the SELECTED provider — an embedded-memory agent has no
  // CORTEX server, and raw CortexBind would drop every chunk on the floor.
  const memorySelection = await createMemoryProvider({
    env,
    router,
    cortex,
    embeddedDbPath: join(home.layer('MEMORY'), 'embedded.jsonl'),
    log: () => {},
  });

  // Vision + PDF caps from config.yaml — images get real analysis when
  // vision.enabled; PDFs respect maxPages/maxBytesMb.
  const ingestOpts: IngestOptions = {
    vision: {
      enabled: config.vision.enabled,
      analyze: config.vision.enabled
        ? (p: string) =>
            analyzeImage(p, { router, models: config.models, vision: config.vision })
        : undefined,
    },
    pdf: { maxPages: config.pdf.maxPages, maxBytesMb: config.pdf.maxBytesMb },
  };

  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(colors.err(`path not found: ${abs}`));
    process.exit(1);
  }
  const st = statSync(abs);
  const targets: string[] = [];
  if (st.isDirectory()) {
    for (const entry of readdirSync(abs)) {
      if (entry.startsWith('.')) continue;
      const sub = join(abs, entry);
      if (statSync(sub).isFile()) targets.push(sub);
    }
  } else {
    targets.push(abs);
  }
  if (targets.length === 0) {
    console.error(colors.err('no files to ingest'));
    process.exit(1);
  }

  console.log(colors.cyan(`Ingesting ${targets.length} file${targets.length === 1 ? '' : 's'} into ${slug}'s CORTEX`));
  console.log('');
  for (const t of targets) {
    process.stdout.write(`  ${colors.muted('·')} ${t} ... `);
    try {
      const r = await ingestFile(memorySelection.provider, t, ingestOpts);
      const memCites =
        r.memoryIds.length > 3
          ? `${r.memoryIds.slice(0, 3).map((i) => `#${i}`).join(', ')} +${r.memoryIds.length - 3}`
          : r.memoryIds.map((i) => `#${i}`).join(', ');
      console.log(
        colors.ok('ok') +
          colors.muted(`  ${r.type}, ${r.chunks} chunks → ${memCites} (${r.durationMs}ms)`),
      );
      for (const w of r.warnings ?? []) {
        console.log(`    ${colors.warn(`warning: ${w}`)}`);
      }
    } catch (err) {
      console.log(colors.err(`failed: ${(err as Error).message}`));
    }
  }
  console.log('');
  console.log(colors.muted('  the agent now remembers these files. ask about them in chat.'));
}
