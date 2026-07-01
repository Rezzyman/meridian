/**
 * Client-facing error firewall (RULE ZERO, ported from the Aterna Hermes
 * `error_sanitizer.py`). No client-facing agent EVER surfaces raw API/provider
 * errors, provider URLs, credit/billing language, error codes, or the names of
 * our own internal machinery/team. Logs keep full detail; anything that can
 * reach a client passes through here first.
 *
 * Two independent guards (apply both at every egress via `sanitizeOutbound`):
 *   1. isLeaky()                — recognizes raw error / billing / auth-token
 *                                 text and replaces the WHOLE message with a
 *                                 safe generic one.
 *   2. redactInternalDisclosure — strips unambiguously-internal provider /
 *                                 runtime / teammate names ("VAPI", "OpenRouter",
 *                                 "AJ"…) from otherwise-fine replies.
 *
 * Earned by real incidents: 2026-05-16 (Zeebo → Jeff Zorbo leaked
 * "Error code: 402 openrouter.ai/settings/credits") and 2026-06-30
 * (Crystal recited "VAPI" / named "AJ" to a client, and a dead Groq key's raw
 * "401 AuthenticateToken authentication failed" reached a client).
 */

/** Single source of truth for the client-safe replacement message. */
export const GENERIC_HICCUP_MESSAGE =
  "Quick hiccup on my end — give me a minute and try that again. " +
  "If it keeps happening, reply 'reset' and I'll start fresh.";

/**
 * Substrings (matched case-insensitively) that mean the text is leaking raw
 * infrastructure/error detail. KEEP TIGHT — only patterns that are unambiguous
 * error-dump signatures, never ordinary words a client agent might legitimately
 * use when helping an operator with THEIR own systems.
 */
const LEAK_SIGNALS: readonly string[] = [
  // Provider URLs / billing pages
  'openrouter.ai',
  'api.anthropic.com',
  'api.openai.com',
  'api.groq.com',
  'console.groq.com',
  '/settings/credits',
  '/settings/billing',
  // Credit / billing / quota language
  'insufficient credits',
  'insufficient balance',
  'add more using',
  'run out of credits',
  'out of credits',
  'insufficient_quota',
  'tokens per minute',
  'tokens per day',
  'rate_limit_exceeded',
  'rate limit reached for model',
  'upgrade to dev tier',
  // HTTP error markers — only appear in error dumps
  'error code: 4',
  'error code: 5',
  'http 401:',
  'http 402:',
  'http 403:',
  'http 404:',
  'http 429:',
  'http 500:',
  // Provider-auth failure tokens — unambiguously internal
  'authenticatetoken',
  'authentication failed',
  'rejected by the provider',
  // Internal/runtime plumbing leakage
  'all providers failed',
  'no providers resolvable',
  // Internal-plumbing narration — server paths, MCP jargon, tool-error dumps.
  // (2026-06-30: Crystal told a client to "get AJ to fix the M365 MCP server
  // at /root/aterna-fleet/mcp-servers/m365/".) Any hit → replace wholesale.
  '/root/',
  '/home/',
  'aterna-fleet',
  'hermes-gateway',
  'mcp server',
  'mcp error',
  '-32602',
  'invalid arguments for tool',
  'invalid_type',
  'validation error',
  'tool definition',
  'server configuration',
];

export function isLeaky(text: string): boolean {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return LEAK_SIGNALS.some((sig) => lowered.includes(sig));
}

/**
 * Replace `text` with the generic hiccup message if it leaks; otherwise return
 * it (capped to keep client messages tight). Use for known-error text.
 */
export function sanitizeUserFacingError(
  text: string,
  fallback: string = GENERIC_HICCUP_MESSAGE,
): string {
  if (!text) return '';
  if (isLeaky(text)) return fallback;
  return text.slice(0, 300);
}

/**
 * Unambiguously-internal tokens → neutral replacements. Scope is deliberately
 * TIGHT: only things that are OURS. Ambiguous infra a client may legitimately
 * own (their 8x8, Twilio, Stripe, CRM, webhook, credentials) is intentionally
 * EXCLUDED so we never mangle genuine help.
 */
const DISCLOSURE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // LLM providers / vendors / models that run us
  [/\b(?:open\s*router|openrouter)\b/gi, 'our system'],
  [/\banthropic\b/gi, 'our system'],
  [/\bgroq\b/gi, 'our system'],
  [/\bopenai\b/gi, 'our system'],
  [/\bclaude\b/gi, 'our system'],
  // Internal runtime / infra (note: "Meridian" is the product brand — left intact)
  [/\b(?:hermes|openclaw|cortex)\b/gi, 'our system'],
  [/\bvapi\b/gi, 'our system'],
  // Server filesystem paths — a client must never see one
  [/\/(?:root|home|etc|var|opt|usr)\/[^\s'"),]+/g, 'our system'],
  // MCP plumbing + internal snake_case tool identifiers (m365_send_email, cortex_recall…)
  [/\bMCP(?:\s+server)?\b/gi, 'our system'],
  [/\b(?:m365|cortex|mcp|graph|hermes|vapi|send)_[a-z0-9_]+\b/gi, 'our tools'],
  // Internal team — never named to a client
  [/@rezzyman\b/gi, 'our team'],
  [/\b(?:rezzyman|rezzy|atanasio)\b/gi, 'our team'],
  [/\b(?:aj|rez)\b/gi, 'our team'],
];

const DISCLOSURE_CLEANUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:the|a|an)\s+our\s+(system|team)\b/gi, 'our $1'],
  [/\b(our (?:system|team))(?:\s+\1\b)+/gi, '$1'],
];

export interface RedactResult {
  text: string;
  redacted: boolean;
}

/**
 * Strip unambiguously-internal provider/runtime/team tokens from a client-facing
 * message. Pure-text and model-independent — safe on every outbound message.
 */
export function redactInternalDisclosure(text: string): RedactResult {
  if (!text) return { text, redacted: false };
  let out = text;
  for (const [pat, repl] of DISCLOSURE_REDACTIONS) out = out.replace(pat, repl);
  if (out !== text) {
    for (const [pat, repl] of DISCLOSURE_CLEANUPS) out = out.replace(pat, repl);
  }
  return { text: out, redacted: out !== text };
}

/**
 * THE last-mile net. Apply to every message before it reaches a client on any
 * channel: a leaky message is replaced wholesale; an otherwise-fine message has
 * internal names redacted.
 */
export function sanitizeOutbound(text: string): string {
  if (!text) return text;
  if (isLeaky(text)) return GENERIC_HICCUP_MESSAGE;
  return redactInternalDisclosure(text).text;
}

/**
 * Error thrown when the whole provider chain fails. Its `message` is the
 * client-safe generic text by construction, so any channel/REPL/gateway path
 * that surfaces `err.message` cannot leak raw provider detail. The raw detail is
 * preserved on `internalDetail` for server-side logging only.
 */
export class ProviderChainError extends Error {
  readonly internalDetail: string;
  constructor(internalDetail: string) {
    super(GENERIC_HICCUP_MESSAGE);
    this.name = 'ProviderChainError';
    this.internalDetail = internalDetail;
  }
}
