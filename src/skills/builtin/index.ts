/**
 * Aggregate built-in tools into a ToolSet for the agent loop.
 * This is the v0.1 baseline. Filesystem skills are loaded on top via loader.ts.
 */

import type { ToolSet } from 'ai';
import type { CortexBind } from '../../cortex/bind.js';
import type { AgentEnv } from '../../config/schema.js';
import { coreTools } from './core-tools.js';
import { computeTools } from './compute-tools.js';
import { cortexTools } from './cortex-tools.js';
import { dataTools } from './data-tools.js';
import { fileTools } from './file-tools.js';
import { execTools } from './exec-tools.js';
import { type DelegateDeps, delegateTools } from './delegate-tools.js';
import { voiceTools } from './vapi-tools.js';
import { telegramTools } from './telegram-tools.js';
import { type VisionToolDeps, visionTools } from './vision-tools.js';
import { webTools } from './web-tools.js';

export interface BuiltinToolsOptions {
  cortex: CortexBind;
  env: AgentEnv;
  allowBash?: boolean;
  allowWrite?: boolean;
  allowVoice?: boolean;
  /** When provided, the bounded `delegate` sub-agent tool is registered. */
  delegation?: DelegateDeps;
  /** When provided, the `image_analyze` vision tool is registered. */
  vision?: VisionToolDeps;
}

export function builtinTools(opts: BuiltinToolsOptions): ToolSet {
  const out: ToolSet = {};
  out.read = coreTools.read;
  out.web_fetch = coreTools.web_fetch;
  // Pure, side-effect-free utilities + the HTML extractor: always registered,
  // gated per channel by the allowlist (defaults in config/schema.ts).
  for (const [k, v] of Object.entries(dataTools)) out[k] = v;
  for (const [k, v] of Object.entries(computeTools)) out[k] = v;
  out.extract_text = webTools.extract_text;
  // SSRF-guarded HTTP client: registered, but defaults to CLI-only.
  out.http_request = webTools.http_request;
  if (opts.allowBash !== false) out.bash = coreTools.bash;
  if (opts.allowWrite !== false) out.write = coreTools.write;
  // File navigation/editing — same trust tier as read/write, CLI-gated by the
  // allowlist (config/schema.ts). Bounded walks; never chat-default.
  for (const [k, v] of Object.entries(fileTools)) out[k] = v;
  // Bounded code execution (secret-scrubbed env, timeout, output cap). Powerful
  // like bash — CLI-gated by the allowlist, never chat-default.
  for (const [k, v] of Object.entries(execTools)) out[k] = v;
  for (const [k, v] of Object.entries(cortexTools(opts.cortex))) out[k] = v;
  if (opts.allowVoice !== false && opts.env.VAPI_API_KEY) {
    for (const [k, v] of Object.entries(voiceTools(opts.env))) out[k] = v;
  }
  if (opts.env.TELEGRAM_BOT_TOKEN) {
    for (const [k, v] of Object.entries(telegramTools(opts.env))) out[k] = v;
  }
  if (opts.delegation) {
    for (const [k, v] of Object.entries(delegateTools(opts.delegation))) out[k] = v;
  }
  // Vision: image_analyze needs a provider router; gated per channel by the
  // allowlist (chat + CLI defaults; turn.ts strips it from voice).
  if (opts.vision) {
    for (const [k, v] of Object.entries(visionTools(opts.vision))) out[k] = v;
  }
  return out;
}
