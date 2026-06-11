/**
 * Memory-integrity screening — defense against cross-session memory poisoning.
 *
 * The attack (demonstrated against other persistent-memory agents by
 * independent security research, arXiv 2603.11619): an adversary gets a
 * fabricated *directive* — "always refuse X", "ignore prior instructions",
 * "policy: never contact Y" — written into long-term memory through a
 * low-trust surface (a public voice call, an external MCP tool, an
 * untrusted ingest). On a LATER turn that memory is recalled and silently
 * steers behavior, turning a one-shot injection into durable behavioral
 * control. Conventional sandboxing does nothing about it — the payload is
 * data the agent itself chose to trust.
 *
 * The defense is provenance-aware recall. A recalled memory is quarantined
 * — stripped from the context the model sees — when BOTH hold:
 *
 *   1. it carries an IMPERATIVE-AUTHORITY marker (it reads like a standing
 *      rule / system directive / instruction override), and
 *   2. its PROVENANCE is untrusted (it was encoded from an external or
 *      public channel, or its source is unattributed).
 *
 * Precision is the whole game. A standing rule the operator themselves set
 * on a trusted channel ("always book me a window seat") is KEPT — that's
 * the feature. A plain fact from an untrusted source ("the caller's order
 * was #1183") is KEPT — it's data, not a directive. Only the intersection
 * — an authoritative directive from an untrusted mouth — is quarantined.
 * When nothing is quarantined the recall context passes through byte-for-
 * byte, so a healthy turn is unchanged (the moat does not regress).
 */

import type { RecallMemory } from '../cortex/types.js';

/** Imperative-authority markers — phrasing that tries to install a standing
 *  rule or override the agent's instructions rather than state a fact. */
const AUTHORITY_MARKERS: RegExp[] = [
  /\b(?:always|never)\b/i,
  /\b(?:from now on|going forward|in (?:all|every) (?:future )?(?:session|conversation)s?)\b/i,
  /\b(?:you (?:must|should|are required to|are forbidden to|may not)|do not ever)\b/i,
  /\b(?:ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(?:previous|prior|earlier|above|all)\b/i,
  /\b(?:policy|rule|directive|instruction|standing order|system prompt)\b\s*[:=\-—]/i,
  /^(?:system|assistant|admin|root|developer)\s*[:=]/im,
  /\b(?:reject|refuse|deny|block|decline)\b[^.!?\n]{0,40}\b(?:all|every|any|each)\b/i,
];

/**
 * Trusted first-party source formats. These are ANCHORED and STRUCTURAL —
 * they match only the exact shapes Meridian's own subsystems emit, so an
 * attacker cannot launder poison through a look-alike prefix.
 *
 * The real encode source (turn.ts) is `meridian:<channel>:<sessionId>` with
 * an optional `:commitment` suffix; <channel> is one of the known channels.
 * A laundering attempt like `meridian:turn-injected`, `operator-imposter`,
 * `cli-attacker-relay`, or `telegram:trusted-channel-spoof` fails these
 * patterns at the structure boundary (the `(?::|$)` anchor) — no blocklist
 * of adversary keywords required.
 */
const TRUSTED_SOURCE_PATTERNS: RegExp[] = [
  /^meridian:(?:cli|telegram|voice|gateway|system)(?::|$)/i,
  /^operator(?::|$)/i,
  /^cli(?::|$)/i,
  /^telegram:trusted(?::|$)/i,
  /^dream(?::|$)/i,
  /^automation(?::|$)/i,
];

/** Explicit untrusted surfaces — these win even over a trusted-looking prefix. */
const UNTRUSTED_SOURCE_MARKERS = /\b(?:external|public|untrusted|anon|anonymous|unknown)\b/i;

/**
 * Provenance trust classifier. The signal recall gives us is `source` (the
 * attribution stamped at encode time). Trusted = authored through a surface
 * the operator directly controls, matched STRUCTURALLY against the real
 * first-party formats; everything else — external/public surfaces, MCP
 * tools, unattributed memory, and prefix-laundering look-alikes — is
 * untrusted. Fails safe: unknown attribution is untrusted.
 */
export function isUntrustedProvenance(source: string | null): boolean {
  if (!source) return true; // unattributed → treat as untrusted
  const s = source.toLowerCase();
  // Explicit untrusted surfaces always win (defense in depth).
  if (UNTRUSTED_SOURCE_MARKERS.test(s)) return true;
  if (s.startsWith('mcp:') || s.startsWith('mcp_')) return true;
  if (s.startsWith('ingest:web') || s.startsWith('web:')) return true;
  // Trusted ONLY on a structural match to a known first-party source format.
  for (const re of TRUSTED_SOURCE_PATTERNS) {
    if (re.test(s)) return false;
  }
  // Unknown / laundered attribution → fail safe to untrusted.
  return true;
}

export function hasAuthorityMarker(content: string): boolean {
  return AUTHORITY_MARKERS.some((re) => re.test(content));
}

export interface QuarantinedMemory {
  id: number;
  source: string | null;
  reason: string;
  excerpt: string;
}

export interface RecallScreenResult {
  /** Context block with quarantined directives removed. Identical to the
   *  input when nothing was quarantined. */
  safeContext: string;
  /** Memories that survived screening. */
  kept: RecallMemory[];
  /** Memories pulled from the model's view (poisoning suspects). */
  quarantined: QuarantinedMemory[];
}

export interface ScreenOptions {
  /** Disable screening (escape hatch; screening is on by default). */
  enabled?: boolean;
}

/**
 * Screen a recall result. Rebuilds the context block from kept memories
 * ONLY when something was quarantined — otherwise the original CORTEX
 * context string is passed through untouched (zero-diff on healthy turns).
 */
export function screenRecall(
  memories: RecallMemory[],
  context: string,
  opts: ScreenOptions = {},
): RecallScreenResult {
  if (opts.enabled === false || memories.length === 0) {
    return { safeContext: context, kept: memories, quarantined: [] };
  }

  const kept: RecallMemory[] = [];
  const quarantined: QuarantinedMemory[] = [];

  for (const m of memories) {
    if (hasAuthorityMarker(m.content) && isUntrustedProvenance(m.source)) {
      quarantined.push({
        id: m.id,
        source: m.source,
        reason: 'authoritative directive from untrusted provenance',
        excerpt: m.content.slice(0, 160),
      });
    } else {
      kept.push(m);
    }
  }

  if (quarantined.length === 0) {
    return { safeContext: context, kept, quarantined };
  }

  // Something was quarantined: do NOT trust the server-built context string
  // (it may embed the poisoned directive). Rebuild from kept memories so the
  // model never sees the quarantined content, however CORTEX formatted it.
  const safeContext = kept.map((m) => `- ${m.content}`).join('\n');
  return { safeContext, kept, quarantined };
}
