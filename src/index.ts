/**
 * Meridian public surface (programmatic).
 * Most users invoke `meridian` via the CLI; this is the import path
 * for embedding Meridian inside another Node process.
 */

export * from './config/index.js';
export * from './cortex/index.js';
export * from './memory/index.js';
export * from './providers/router.js';
export * from './agent/index.js';
export * from './session/index.js';
export * from './skills/index.js';
export * from './channels/index.js';
export * from './verification/index.js';
export * from './audit/index.js';
export * from './dream/weaver.js';
export * from './heartbeat/index.js';

// MCP (client + server), delegation, structured output — parity surface.
export * from './mcp/index.js';
export { delegateTools, type DelegateDeps } from './skills/builtin/delegate-tools.js';
export { defineTool, type DefineToolOptions, type ExecutionFailure, type OutputValidationFailure } from './skills/toolkit.js';
export {
  generateStructured,
  StructuredOutputError,
  type GenerateStructuredOptions,
  type StructuredResult,
} from './agent/structured.js';
