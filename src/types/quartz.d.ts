/**
 * Ambient declaration for the OPTIONAL proprietary dependency @aterna/quartz.
 *
 * Quartz is an optionalDependency (file:../quartz) that is intentionally NOT
 * present in the open-source checkout. memory/factory.ts loads it via a guarded
 * dynamic `import('@aterna/quartz')` inside try/catch and falls back to CORTEX
 * when it is absent — so the runtime is already safe. This shim only stops the
 * type-checker from failing with TS2307 ("Cannot find module") when the package
 * is not installed, keeping `pnpm typecheck`/`pnpm build` green on a clean tree.
 *
 * When the real @aterna/quartz is installed, its own bundled types take
 * precedence over this permissive fallback.
 */
declare module '@aterna/quartz' {
  // Intentionally untyped: the concrete shape is asserted at the load boundary
  // in memory/factory.ts (loadQuartzPipeline) and validated at first call.
  const value: unknown;
  export = value;
}
