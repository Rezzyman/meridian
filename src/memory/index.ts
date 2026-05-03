/**
 * Memory provider seam.
 *
 * MemoryProvider is the abstract interface every Meridian subsystem consumes
 * for cognitive memory. CortexMemoryProvider is the open-source default
 * implementation; QuartzMemoryProvider can be selected at boot time via the
 * MERIDIAN_MEMORY_PROVIDER env var (wired in Phase 3b).
 */
export type {
  DreamCycleType,
  EncodeOptions,
  ListArtifactsOptions,
  ListArtifactsResult,
  MemoryProvider,
  RecallOptions,
  // Re-exported domain types from cortex/types so callers can import a single module.
  CortexHealth,
  CortexStats,
  DreamCycleResult,
  EncodeResult,
  RecallArtifact,
  RecallResult,
  ValenceVector,
} from './provider.js';

export {
  CortexMemoryProvider,
  bindCortexMemoryProvider,
  createCortexMemoryProvider,
} from './cortex-memory-provider.js';
export type { CortexMemoryProviderOptions } from './cortex-memory-provider.js';

export { QuartzMemoryProvider } from './quartz-memory-provider.js';
export type { QuartzMemoryProviderOptions } from './quartz-memory-provider.js';

export { CortexBackendAdapter } from './cortex-backend-adapter.js';
export type {
  CortexBackend,
  CortexBackendAdapterOptions,
} from './cortex-backend-adapter.js';

export { createMemoryProvider } from './factory.js';
export type {
  CreateMemoryProviderOptions,
  CreateMemoryProviderResult,
} from './factory.js';
