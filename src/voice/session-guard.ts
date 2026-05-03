/**
 * VoiceSessionGuard — passphrase-gated unlock for the voice channel.
 *
 * The public voice line is the most exposed surface a Meridian agent has.
 * Anyone with the phone number can call. Default behaviour is therefore
 * PUBLIC mode:
 *  - public-only memory recall
 *  - sacred-topic regex blocks
 *  - no privileged tool calls (no DMing the operator, no encoding to memory,
 *    no explicit recall)
 *
 * Some calls are operator calls (the operator dialing their own line to use
 * the agent as a partner) or trusted-caller calls. For those, the agent
 * must be able to reach internal memories, encode commitments, and DM via
 * Telegram. A passphrase unlock is the cleanest mechanism:
 *
 *  1. Operator sets the phrase ahead of time via `meridian voice passphrase`.
 *     The vault stores a normalised lowercase form; encrypted at rest.
 *  2. On any inbound transcript, the channel layer scans for the phrase.
 *  3. Match → unlock that call's id for a configurable window (default 30 min)
 *     AND strip the phrase from the text before the model ever sees it.
 *     The stripped text becomes the model's input; if the only content was
 *     the phrase, the call goes silent (no turn fires).
 *  4. Tools check `isUnlocked(callId)` before running; locked calls get a
 *     clean refusal the model can surface naturally to the caller.
 *
 * Why store normalised plaintext (not just a hash):
 *   - STT mangles punctuation/casing/spacing inconsistently. Hashing fails on
 *     "purple-typewriter-47" vs "purple typewriter 47" vs "Purple Typewriter
 *     47." We need substring matching after normalisation.
 *   - The vault is already encrypted at rest with the agent's MERIDIAN_VAULT_KEY.
 *     A plaintext phrase inside an encrypted vault is the same security
 *     posture as any other vault secret (OAuth refresh tokens, API keys).
 */

import type { Logger } from 'pino';
import type { Vault } from '../secrets/vault.js';

const VAULT_KEY = 'voice.passphrase';
const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes per unlock

/** Normalise a phrase or transcript fragment for case/punct-insensitive compare. */
export function normalisePhrase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ScanResult {
  /** The transcript with the passphrase removed (if matched). */
  stripped: string;
  /** True if the passphrase was found and the call is now unlocked. */
  unlocked: boolean;
  /** True if the entire transcript was just the passphrase (nothing else to send to the model). */
  empty: boolean;
}

export class VoiceSessionGuard {
  private unlockedCalls = new Map<string, number>(); // callId → expiresAt ms

  constructor(private vault: Vault, private logger: Logger) {}

  /** Has the operator configured a voice passphrase yet? */
  isConfigured(): boolean {
    const v = this.vault.get<string>(VAULT_KEY);
    return typeof v === 'string' && v.length > 0;
  }

  /** Set or rotate the passphrase. Stored normalised. */
  setPassphrase(raw: string): void {
    const norm = normalisePhrase(raw);
    if (norm.length < 4) {
      throw new Error('voice passphrase too short after normalisation (need ≥4 chars of letters/digits)');
    }
    this.vault.set(VAULT_KEY, norm);
  }

  /** Clear the passphrase. Voice tools become unreachable until a new one is set. */
  clearPassphrase(): void {
    this.vault.set(VAULT_KEY, '');
  }

  /**
   * Scan an incoming voice transcript for the passphrase. If matched, unlock
   * the callId and return the transcript with the phrase removed. If no
   * passphrase is configured, this is a no-op (returns the transcript as-is
   * and never unlocks).
   */
  scanAndUnlock(callId: string | undefined, transcript: string, windowMs = DEFAULT_WINDOW_MS): ScanResult {
    const phrase = this.vault.get<string>(VAULT_KEY);
    if (!phrase || !callId) return { stripped: transcript, unlocked: false, empty: false };

    const norm = normalisePhrase(transcript);
    if (!norm.includes(phrase)) {
      return { stripped: transcript, unlocked: false, empty: false };
    }

    // Match. Unlock + strip.
    this.unlockedCalls.set(callId, Date.now() + windowMs);
    this.logger.info({ msg: 'voice session unlocked', callId, windowMs });

    // Best-effort strip: rebuild the transcript word-by-word, dropping any
    // contiguous run of words whose normalised form contains the phrase.
    const stripped = stripPhraseFromTranscript(transcript, phrase);
    const remaining = normalisePhrase(stripped);
    return {
      stripped,
      unlocked: true,
      // If after stripping there's effectively no content, the only thing the
      // caller said was the passphrase — don't fire a model turn for that.
      empty: remaining.length === 0,
    };
  }

  /** Is this call currently in an unlocked window? */
  isUnlocked(callId: string | undefined): boolean {
    if (!callId) return false;
    const exp = this.unlockedCalls.get(callId);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.unlockedCalls.delete(callId);
      return false;
    }
    return true;
  }

  /** Force-end an unlock (e.g. operator hangs up; cleanup at end-of-call-report). */
  lock(callId: string | undefined): void {
    if (!callId) return;
    this.unlockedCalls.delete(callId);
  }

  /** Window time remaining in ms, or 0 if locked. For status surfaces. */
  remainingMs(callId: string | undefined): number {
    if (!callId) return 0;
    const exp = this.unlockedCalls.get(callId);
    if (!exp) return 0;
    const left = exp - Date.now();
    return left > 0 ? left : 0;
  }
}

/**
 * Walk through the transcript and drop any contiguous run of words whose
 * joined-and-normalised form contains the passphrase. Preserves surrounding
 * punctuation and casing for everything else.
 */
function stripPhraseFromTranscript(transcript: string, phrase: string): string {
  // Split into tokens that include their separators so we can rebuild.
  const parts = transcript.split(/(\s+|[.,!?;:])/);
  // For each run of "word" tokens, check if any contiguous slice covers the
  // phrase. Walk a sliding window over word indices.
  const wordIdx: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (/\S/.test(parts[i]) && !/^[.,!?;:\s]+$/.test(parts[i])) wordIdx.push(i);
  }
  if (wordIdx.length === 0) return transcript;

  // Find a window of word indices that, when joined+normalised, contains the phrase.
  for (let start = 0; start < wordIdx.length; start++) {
    for (let end = start; end < wordIdx.length; end++) {
      const slice = parts.slice(wordIdx[start], wordIdx[end] + 1).join('');
      if (normalisePhrase(slice).includes(phrase)) {
        // Drop this slice (and any trailing punctuation immediately after).
        const before = parts.slice(0, wordIdx[start]).join('');
        let afterStart = wordIdx[end] + 1;
        while (afterStart < parts.length && /^[.,!?;:\s]+$/.test(parts[afterStart])) afterStart++;
        const after = parts.slice(afterStart).join('');
        return (before + ' ' + after).replace(/\s+/g, ' ').trim();
      }
    }
  }
  return transcript;
}
