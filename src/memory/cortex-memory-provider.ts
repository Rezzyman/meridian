/**
 * CortexMemoryProvider — the open-source default MemoryProvider for Meridian.
 *
 * Wraps the existing CortexBind transport. CortexBind already implements
 * MemoryProvider (see `src/cortex/bind.ts`); this module re-exports it under
 * the provider-shaped name and gives callers a factory that returns the
 * interface type rather than the concrete class.
 *
 * Pattern: every new caller depends on `MemoryProvider`, not `CortexBind`.
 * Existing callers using `CortexBind` continue to work unchanged.
 */
import { CortexBind, bindCortex, type CortexBindOptions } from '../cortex/bind.js';
import type { MemoryProvider } from './provider.js';

/**
 * Concrete MemoryProvider implementation backed by a co-located CORTEX
 * server. This is the same class as CortexBind; the alias makes the
 * provider role explicit in new code.
 */
export const CortexMemoryProvider = CortexBind;
export type CortexMemoryProvider = CortexBind;

export type CortexMemoryProviderOptions = CortexBindOptions;

/**
 * Factory: returns a MemoryProvider backed by CORTEX.
 *
 * Use this from boot wiring (cli/main.ts, gateway, doctor). Existing callers
 * that need the underlying CortexBind handle for CORTEX-specific calls
 * (e.g. valence inference helpers) can keep using `bindCortex(...)` directly.
 */
export function createCortexMemoryProvider(opts: CortexMemoryProviderOptions): MemoryProvider {
  return new CortexBind(opts);
}

/**
 * Convenience matching the existing `bindCortex(agentId, baseUrl)` signature
 * but typed to the provider interface. Drop-in replacement at call sites
 * that only need the abstract surface.
 */
export function bindCortexMemoryProvider(agentId: string, baseUrl?: string): MemoryProvider {
  return bindCortex(agentId, baseUrl);
}
