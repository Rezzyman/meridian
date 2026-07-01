/**
 * Precompile bundled skills' `tools.ts` → `tools.mjs`.
 *
 * Why this exists: the shipped runtime is `node dist/…` with no tsx loader, and
 * plain Node <22 throws ERR_UNKNOWN_FILE_EXTENSION on `import('tools.ts')`. The
 * skill loader (src/skills/loader.ts) prefers a compiled `tools.mjs`, so every
 * executable skill (github/google/wearables/web-search) works on the documented
 * Node 20 floor. Run automatically by `pnpm build` after tsup.
 *
 * The bundled skills declare their SkillToolContext locally and receive
 * `tool`/`z` through ctx, so they have NO runtime imports — a plain type-strip
 * transform yields a self-contained ESM module that resolves anywhere (including
 * a user's ~/.meridian/<agent>/SKILLS/<name>/ where node_modules is out of reach).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = join(root, 'skeleton', 'SKILLS');

if (!existsSync(skillsRoot)) {
  console.error(`build-skills: no skeleton/SKILLS at ${skillsRoot}`);
  process.exit(1);
}

let compiled = 0;
for (const entry of readdirSync(skillsRoot)) {
  const dir = join(skillsRoot, entry);
  if (!statSync(dir).isDirectory()) continue;
  const toolsTs = join(dir, 'tools.ts');
  if (!existsSync(toolsTs)) continue;

  const src = readFileSync(toolsTs, 'utf8');
  const result = await esbuild.transform(src, {
    loader: 'ts',
    format: 'esm',
    target: 'node20',
    // No bundling: these files have no runtime imports, so a transform is enough
    // and keeps the output readable + dependency-free.
  });
  if (result.warnings.length) {
    for (const w of result.warnings) console.warn(`build-skills: ${entry}: ${w.text}`);
  }
  const banner =
    '// AUTO-GENERATED from tools.ts by scripts/build-skills.mjs — do not edit.\n' +
    '// Loaded in preference to tools.ts so executable skills run on Node 20+.\n';
  writeFileSync(join(dir, 'tools.mjs'), banner + result.code);
  compiled += 1;
  console.log(`build-skills: compiled ${entry}/tools.ts → tools.mjs`);
}

console.log(`build-skills: ${compiled} skill module(s) compiled.`);
