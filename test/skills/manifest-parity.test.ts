/**
 * Defect (e), July 2026: the google skill's manifest and its tools.ts drifted
 * (v0.1 exposed gmail_recent, v0.2 did not), so an automation called a tool
 * that no longer existed. Every bundled v2 skill must declare exactly the
 * tools its createTools() returns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { makeEnv, silentLogger } from '../helpers/fixtures.js';
import type { SkillToolContext } from '../../src/skills/runtime.js';
import type { AgentEnv } from '../../src/config/schema.js';

const SKILLS = join(process.cwd(), 'skeleton', 'SKILLS');

function stubCtx(): SkillToolContext {
  const store = new Map<string, unknown>();
  return {
    agentSlug: 'test-agent',
    vault: {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => void store.set(k, v),
      setMany: (entries: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(entries)) store.set(k, v);
      },
      has: (k: string) => store.has(k),
      list: () => [...store.keys()],
      delete: (k: string) => void store.delete(k),
    },
    env: makeEnv() as AgentEnv,
    logger: silentLogger,
    requirePassphrase: () => {},
    hashPassphrase: (raw: string) => raw,
    grantPassphraseSession: () => {},
    tool,
    z,
    tools: {
      gog: {
        run: async () => ({ stdout: '', stderr: '', code: 0 }),
        runJson: async () => ({}),
        listAccounts: async () => [],
      },
    },
  } as unknown as SkillToolContext;
}

describe('bundled skill manifests match their tool exports', () => {
  const v2 = readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter(
      (n) =>
        existsSync(join(SKILLS, n, 'manifest.yaml')) && existsSync(join(SKILLS, n, 'tools.ts')),
    );

  it('finds the bundled v2 skills', () => {
    assert.ok(v2.includes('google'));
    assert.ok(v2.includes('github'));
    assert.ok(v2.includes('web-search'));
  });

  for (const name of v2) {
    it(`${name}: every manifest tool exists in createTools() and vice versa`, async () => {
      const manifest = parseYaml(readFileSync(join(SKILLS, name, 'manifest.yaml'), 'utf8')) as {
        tools?: Array<{ name: string }>;
      };
      const declared = (manifest.tools ?? []).map((t) => t.name).sort();
      const mod = (await import(join(SKILLS, name, 'tools.ts'))) as {
        createTools: (ctx: SkillToolContext) => Record<string, unknown>;
      };
      const exported = Object.keys(mod.createTools(stubCtx())).sort();
      assert.deepEqual(exported, declared, `${name}: manifest and tools.ts disagree`);
    });
  }

  it('google keeps the v0.1 gmail_recent alias so old automations still resolve', async () => {
    const mod = (await import(join(SKILLS, 'google', 'tools.ts'))) as {
      createTools: (ctx: SkillToolContext) => Record<string, unknown>;
    };
    assert.ok('gmail_recent' in mod.createTools(stubCtx()));
  });
});
