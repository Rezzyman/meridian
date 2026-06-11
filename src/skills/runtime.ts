/**
 * Skill runtime — the contract a skill's tools.ts file uses to access
 * agent capabilities. Every dynamically-loaded skill receives a
 * SkillToolContext at registration time and uses it to talk to CORTEX,
 * the encrypted vault, the agent's env, and the passphrase guard.
 *
 * This is the public surface for skill authors. Anything they touch on
 * the runtime side flows through this object.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { tool as aiTool } from 'ai';
import { z as zod } from 'zod';
import type { Logger } from 'pino';
import type { defineTool as defineToolFactory } from './toolkit.js';
import type { CortexBind } from '../cortex/bind.js';
import type { Vault } from '../secrets/vault.js';
import type { AgentEnv } from '../config/schema.js';
import type { GogRunOptions, GogRunResult } from '../tools/gog.js';

/**
 * Bundled-tool helpers exposed to skills. These wrap Meridian's vendored
 * binaries (gog for Google Workspace, etc.) so a skill never has to know
 * where the binary lives or how to download it. Adding a new bundled tool?
 * Add a member here and a wrapper in skill-runtime.ts.
 */
export interface BundledTools {
  gog: {
    run: (opts: GogRunOptions) => Promise<GogRunResult>;
    runJson: <T = unknown>(opts: GogRunOptions) => Promise<T>;
    listAccounts: (client: string) => Promise<Array<{ email: string; client: string; scopes: string; expires?: string; type: string }>>;
  };
}

export interface SkillToolContext {
  cortex: CortexBind;
  vault: Vault;
  /** Typed core env. The runtime ALSO mutates this object at boot to
   *  include any keys declared by loaded skills' `manifest.yaml#requires.env[]`.
   *  Those merged keys aren't visible in the strict TypeScript shape, but
   *  they're present at runtime. Skill code that reads them via the loose
   *  `Record<string, string|undefined>` shape declared inside each
   *  tools.ts gets the value as expected. The decoupling means new
   *  env-using skills declare their needs in their manifest only — no
   *  AgentEnvSchema or loadAgentEnv edits required. */
  env: AgentEnv;
  logger: Logger;
  /** Throws if the candidate passphrase is missing or invalid for the named skill. */
  requirePassphrase: (skillName: string, candidate?: string) => void;
  /** Hash a passphrase the same way the vault stores it (used by setup walkthroughs). */
  hashPassphrase: (raw: string) => string;
  /** Mark the operator authorized for a skill for `windowMinutes`. */
  grantPassphraseSession: (skillName: string, windowMinutes?: number) => void;
  /** AI SDK `tool` factory. Skills receive this so they don't need `ai`
   *  resolvable from their own install location. */
  tool: typeof aiTool;
  /** Zod factory passed through for the same reason. */
  z: typeof zod;
  /** Output-validated tool factory (skills/toolkit.ts): declare an
   *  `output` Zod schema and every result is validated before it reaches
   *  the model — mismatches return { ok:false, error:'output_validation',
   *  issues } so the model self-corrects. Same import-isolation rationale
   *  as `tool`/`z`. */
  defineTool: typeof defineToolFactory;
  /** Meridian-bundled tool binaries (gog, etc.) wrapped so skills never
   *  have to resolve filesystem paths into the meridian source tree. */
  tools: BundledTools;
}

interface SessionToken {
  skillName: string;
  expiresAt: number;
}

/**
 * Passphrase guard with session windows. Skills that flag
 * `requiresPassphrase: true` on their manifest call ctx.requirePassphrase()
 * before doing anything sensitive. The candidate passphrase is checked
 * against the vault-stored hash. On match, an in-memory session token is
 * issued for the configured window (default 30 min) so the operator does
 * not have to re-enter on every call.
 *
 * If you want to make EVERY call require fresh authorization for a
 * specific skill, set sessionWindowMinutes: 0 in its manifest.
 */
export class PassphraseGuard {
  private sessions = new Map<string, SessionToken>();

  constructor(private readonly vault: Vault) {}

  static hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  /** Setup-time helper: store the hash for a skill's passphrase. */
  setPassphrase(skillName: string, raw: string): void {
    this.vault.set(`skill.${skillName}.passphrase_hash`, PassphraseGuard.hash(raw));
  }

  hasPassphrase(skillName: string): boolean {
    return this.vault.has(`skill.${skillName}.passphrase_hash`);
  }

  /** Mark the operator as authorized for a skill for `windowMinutes`. */
  grant(skillName: string, windowMinutes = 30): void {
    if (windowMinutes <= 0) return; // 0 = never grant a session
    const expiresAt = Date.now() + windowMinutes * 60 * 1000;
    this.sessions.set(skillName, { skillName, expiresAt });
  }

  isAuthorized(skillName: string): boolean {
    const t = this.sessions.get(skillName);
    if (!t) return false;
    if (t.expiresAt < Date.now()) {
      this.sessions.delete(skillName);
      return false;
    }
    return true;
  }

  revoke(skillName: string): void {
    this.sessions.delete(skillName);
  }

  /**
   * Throw a structured error the agent runtime can catch and surface to
   * the operator as a passphrase challenge. The error message follows a
   * convention the model is taught about in IDENTITY/AGENT.md so the LLM
   * politely asks the operator instead of fabricating a result.
   */
  require(skillName: string, candidate?: string, windowMinutes = 30): void {
    if (this.isAuthorized(skillName)) return;
    const stored = this.vault.get<string>(`skill.${skillName}.passphrase_hash`);
    if (!stored) {
      throw new SkillPassphraseError(
        skillName,
        'NOT_CONFIGURED',
        `the ${skillName} skill has no passphrase set. run \`meridian skills setup ${skillName}\` to configure it.`,
      );
    }
    if (!candidate) {
      // Generate a one-shot nonce so the agent's reply tells the operator
      // exactly how to respond. The nonce is informational only — the
      // actual auth check is constant-time.
      const nonce = randomBytes(4).toString('hex');
      throw new SkillPassphraseError(
        skillName,
        'CHALLENGE_REQUIRED',
        `passphrase required for ${skillName} (challenge ${nonce}). reply with "/auth ${skillName} <passphrase>" to authorize for ${windowMinutes} min.`,
      );
    }
    const candidateHash = PassphraseGuard.hash(candidate);
    if (
      candidateHash.length !== stored.length ||
      !timingSafeEqual(Buffer.from(candidateHash), Buffer.from(stored))
    ) {
      throw new SkillPassphraseError(
        skillName,
        'INVALID',
        `passphrase did not match for ${skillName}. session not granted.`,
      );
    }
    this.grant(skillName, windowMinutes);
  }
}

export class SkillPassphraseError extends Error {
  readonly skillName: string;
  readonly code: 'NOT_CONFIGURED' | 'CHALLENGE_REQUIRED' | 'INVALID';
  constructor(skillName: string, code: SkillPassphraseError['code'], message: string) {
    super(message);
    this.name = 'SkillPassphraseError';
    this.skillName = skillName;
    this.code = code;
  }
}
