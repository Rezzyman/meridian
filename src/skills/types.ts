/**
 * Skills are AgentOS Layer 3. Filesystem-discovered. Compatible with
 * agentskills.io frontmatter so OpenClaw and Hermes skills work in Meridian
 * unchanged.
 */

import type { Tool } from 'ai';
import type { SkillManifest, SkillManifestV2 } from '../config/schema.js';

export interface LoadedSkill {
  manifest: SkillManifest;
  /** v2 manifest if the skill ships a manifest.yaml with declarations
   *  (env, vault, oauth, passphrase, tools[]). Optional — legacy skills
   *  with only SKILL.md still work. */
  manifestV2?: SkillManifestV2;
  /** Absolute path to skill directory */
  path: string;
  /** AI SDK tool wrapping this skill (markdown skills compile to a "follow-instructions" tool) */
  tool: Tool;
  /** Tools declared and instantiated by the skill's tools.ts (v2 only).
   *  Each entry is a real callable Tool registered with the agent. */
  dynamicTools?: Record<string, Tool>;
  /** Source: 'builtin' | 'global' | 'agent' */
  source: 'builtin' | 'global' | 'agent';
  /** Category for boot panel grouping */
  category: string;
}

export interface SkillRegistry {
  list(): LoadedSkill[];
  byName(name: string): LoadedSkill | undefined;
  byCategory(): Record<string, LoadedSkill[]>;
  asTools(): Record<string, Tool>;
  /** Union of every env key declared by any loaded v2 skill's
   *  `manifest.yaml#requires.env[]`. The runtime reads these from
   *  process.env and merges into SkillToolContext.env so skills can
   *  read their declared keys without a core schema/loader edit. */
  declaredEnvKeys(): string[];
}
