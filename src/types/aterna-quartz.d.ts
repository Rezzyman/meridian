/**
 * Ambient declaration for the proprietary @aterna/quartz package.
 *
 * Quartz is lazy-imported at runtime only when MERIDIAN_MEMORY_PROVIDER=quartz
 * (see src/memory/factory.ts loadQuartzPipeline). The package is private and
 * not installed in OSS checkouts, so we declare the module shape here to keep
 * `tsc --noEmit` green. The structural contract the runtime actually relies on
 * is QuartzPipeline in src/memory/quartz-memory-provider.ts; factory.ts casts
 * at the trust line and mismatches surface at first call, not at boot.
 */
declare module "@aterna/quartz" {
  export const QuartzMemoryProvider:
    | (new (
        backend: unknown,
        opts?: Record<string, unknown>,
      ) => unknown)
    | undefined;
}
