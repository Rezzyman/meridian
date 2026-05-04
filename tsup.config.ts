/**
 * tsup build config for production deployments.
 *
 * The CLI runs from `src/` via tsx in dev. For production deployments
 * where you don't want a tsx loader in the path (faster boot, smaller
 * runtime, simpler systemd unit), `pnpm build` emits a `dist/` tree
 * the bin/meridian launcher prefers automatically.
 *
 * Two entry points:
 *   - dist/cli/main.js    the CLI itself (the bin script targets this)
 *   - dist/index.js       package public surface (memory provider seam,
 *                         types, and a few helpers downstream consumers
 *                         can import as a library)
 *
 * Externalizing every runtime dep keeps the bundle thin — they're
 * resolved from node_modules at runtime, not duplicated. Skills
 * (skeleton/SKILLS/<name>/tools.ts) are NOT bundled by tsup; they're
 * dynamically imported at runtime against the agent's installed copy
 * under ~/.meridian/<agent>/SKILLS/. The skeleton dir ships with the
 * package but stays as source files.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/main': 'src/cli/main.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false, // CLI doesn't need d.ts; library consumers can import source paths
  shims: false,
  // Keep all runtime deps external. They land via node_modules.
  skipNodeModulesBundle: true,
  // Don't try to bundle dynamic skill imports or built-in node modules.
  external: [
    /^node:/,
    '@aterna/quartz', // optional, lazy-imported
  ],
  outDir: 'dist',
});
