# Authoring a Meridian skill

A skill is a capability you drop into an agent's `SKILLS/` layer. It can be pure
instructions (markdown the agent reads when relevant) or real executable tools
(a `tools.ts` that calls an API, runs a computation, hits a device). This guide
walks one executable skill end to end: manifest, tools, credentials, build,
install, verify.

If you have ten minutes, copy `skeleton/SKILLS/web-search/` and edit it. The rest
of this page explains what each part does so you can go beyond copy-paste.

---

## Where skills live

Every agent home has a seven-layer scaffold; skills live under `SKILLS/`:

```
~/.meridian/<agent>/SKILLS/<skill-name>/
  SKILL.md        # required: frontmatter + instructions the model reads
  manifest.yaml   # optional (v2): declares tools, required env/vault/passphrase
  tools.ts        # optional: exports createTools(ctx) for executable tools
  setup.md        # optional: human setup notes, shown by `meridian skills setup`
```

The loader (`src/skills/loader.ts`) walks three tiers and merges them, with the
later tier overriding the earlier on a name clash:

```
bundled (shipped catalog)  →  ~/.meridian/skills (global)  →  <agent>/SKILLS (per-agent)
```

So a per-agent skill shadows a global one, which shadows a bundled one. That is
how you override a bundled skill for one agent without forking anything.

---

## 1. SKILL.md — the instructions

`SKILL.md` is markdown with a YAML frontmatter header. The frontmatter is
`agentskills.io`-compatible, so skills written for that standard interoperate.

```markdown
---
name: dice
description: Roll dice for the operator (NdM notation), with a fair PRNG
category: utility
runtime: ts
trigger: operator asks me to roll dice, flip a coin, or pick a random number
---

I can roll dice on request. Use the `roll_dice` tool.

## When to use
- "roll 2d6", "flip a coin" (1d2), "pick a number 1-100" (1d100)

## When NOT to use
- Anything that needs real randomness for security. This is a game roller.
```

The body is what the model sees when the skill is relevant. Even a skill with
executable tools always gets a generic wrapper tool that returns this SKILL.md on
demand, so the instructions are always reachable. Write the body as guidance to
the agent in the first person ("I can...", "I never...").

Frontmatter fields the loader reads: `name` (defaults to the directory name if
omitted), `description`, `category`, `runtime` (`markdown` or `ts`), and any
extra keys you want (`trigger`, `sources`, `output_format`) which are carried
through for your own use.

---

## 2. manifest.yaml — declaring tools and requirements

A skill with executable tools adds a v2 `manifest.yaml`. It declares the tool
names (for the boot panel and doctor), and what the skill needs to run:

```yaml
name: dice
version: 0.1.0
description: Fair dice roller
category: utility

# Requirements. The runtime merges declared env keys into ctx.env, and vault
# keys are read/written through ctx.vault. Declare only what you use.
requires:
  env: []                       # e.g. [SOME_API_BASE_URL]
  vault:
    - skill.dice.house_seed     # convention: skill.<name>.<key>

passphrase:
  required: false               # true → privileged tools need an unlock

tools:
  - name: roll_dice
    description: Roll dice in NdM notation and return the total and each die

setup: setup.md                 # optional; run by `meridian skills setup dice`
```

Declared `env` keys flow into `ctx.env` automatically. Vault keys are the secret
store: `meridian skills setup` writes them, `tools.ts` reads them via `ctx.vault`,
and they never land in plain `.env` or in the model's context.

---

## 3. tools.ts — the executable tools

`tools.ts` exports one function, `createTools(ctx)`, returning a map of tool name
to tool. The important design choice: `tool` and `z` (Zod) are handed to you
through `ctx`, so your skill does NOT import `ai` or `zod` directly. That keeps a
skill self-contained and loadable from an agent home where those packages are not
on the resolution path.

```ts
// SkillToolContext is provided by the runtime; declare the slice you use.
interface Ctx {
  vault: { get<T = unknown>(key: string): T | undefined; set(k: string, v: unknown): void };
  env: Record<string, string | undefined>;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  tool: (def: unknown) => unknown;
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown };
    number: () => { int: () => { min: (n: number) => { max: (n: number) => unknown } } };
  };
}

export function createTools(ctx: Ctx): Record<string, unknown> {
  const { tool, z } = ctx;
  return {
    roll_dice: tool({
      description: 'Roll dice in NdM notation (e.g. 2d6) and return the total and each die.',
      parameters: z.object({
        notation: z.string().describe('Dice notation like 2d6 or 1d20'),
      }),
      // Return DATA, not exceptions. The model handles a structured error far
      // better than a thrown one.
      execute: async ({ notation }: { notation: string }) => {
        const m = /^(\d+)d(\d+)$/.exec(notation.trim());
        if (!m) return { error: 'bad_notation', message: 'Use NdM, e.g. 2d6.' };
        const [n, sides] = [Number(m[1]), Number(m[2])];
        if (n < 1 || n > 100 || sides < 2 || sides > 1000) {
          return { error: 'out_of_range', message: 'n in 1..100, sides in 2..1000.' };
        }
        const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
        return { notation, rolls, total: rolls.reduce((a, b) => a + b, 0) };
      },
    }),
  };
}
```

Contract notes:

- Tool names in the returned map are what the model calls, and they override the
  markdown wrapper for that skill.
- Return structured results. A tool that finds nothing should return `{}` or `[]`
  or `{ error, message }`, never throw. The runtime screens empty results and,
  if a tool returns empty twice in a turn, short-circuits further calls so the
  model answers from context instead of hammering it.
- `execute` is `async` and receives the validated args plus the AI SDK tool
  options; you can ignore the second argument.

### Credentials

Read secrets from the vault, never from a hard-coded string:

```ts
const key = ctx.vault.get<string>('skill.web-search.tavily_api_key');
if (!key) return { error: 'not_configured', message: 'Run `meridian skills setup web-search`.' };
```

### Privileged tools (passphrase)

If `passphrase.required: true`, gate a sensitive tool with the guard the runtime
passes in:

```ts
ctx.requirePassphrase('my-skill'); // throws if this session is not unlocked
```

On voice, the operator unlocks by speaking the passphrase; on text channels the
session is trusted by provenance. See `docs/memory-poisoning.md` for the trust model.

### An optional setup(ctx) hook

Export a `setup(ctx)` function to drive an interactive credential walkthrough
(OAuth, multi-step keys). `meridian skills setup <name>` calls it. Look at
`skeleton/SKILLS/google/tools.ts` for a real OAuth example.

---

## 4. Build: tools.ts becomes tools.mjs

The shipped runtime is `node dist/` with no TypeScript loader, and plain Node
cannot `import` a `.ts` file. So bundled skills are compiled: `pnpm build` runs
`scripts/build-skills.mjs`, which type-strips each `skeleton/SKILLS/*/tools.ts`
into a `tools.mjs` next to it. The loader prefers `tools.mjs` over `tools.ts`, so
executable skills work on the documented Node 20 floor.

For a skill you author in your own repo, either ship a compiled `tools.mjs`
alongside `tools.ts`, or run under a TypeScript-capable runtime (Node 22+ strips
types natively; `tsx` in dev). If the loader finds only a raw `.ts` it cannot
load, it warns loudly rather than dropping the tools silently.

---

## 5. Install, verify, use

```bash
# Bundled skill from the catalog:
meridian skills install web-search
meridian skills setup web-search      # paste the API key into the vault

# Your own skill: drop the directory into the agent's SKILLS/ layer, then:
meridian doctor                       # "Skills parse" confirms it loaded cleanly
meridian skills list                  # shows it, with a badge if it has tools
meridian                              # chat; the model can now call your tool
```

`meridian doctor` parses every SKILL.md frontmatter and loads each `tools.ts`,
reporting how many skills loaded and how many carry executable tools. If your
tool is missing there, that is where the reason shows up.

---

## Checklist

- [ ] `SKILL.md` with frontmatter (`name`, `description`, `category`, `runtime`)
- [ ] `manifest.yaml` declaring `tools[]` and any `requires.env` / `requires.vault`
- [ ] `tools.ts` exporting `createTools(ctx)`, using `ctx.tool` / `ctx.z`
- [ ] Tools return structured data, never throw; empty results are `{}`/`[]`
- [ ] Secrets read from `ctx.vault`, declared in the manifest
- [ ] Compiled `tools.mjs` shipped, or run on a TS-capable runtime
- [ ] `meridian doctor` shows the skill loaded with its tools

Copy `skeleton/SKILLS/web-search/` for an API skill, `skeleton/SKILLS/google/`
for an OAuth skill, and `skeleton/SKILLS/wearables/` for a multi-provider adapter
pattern.
