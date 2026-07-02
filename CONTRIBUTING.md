# Contributing to Meridian

Thank you for considering a contribution. Meridian is open source under MIT and we want it to stay sharp.

## Filing issues

Use [GitHub Issues](https://github.com/Rezzyman/meridian/issues) for:
- Bugs (include OS, Node version, the command you ran, and the output)
- Feature requests (describe the use case first; the feature is the answer)
- Documentation gaps

Search existing issues before opening a new one.

For security-related reports, see [SECURITY.md](SECURITY.md) instead. Do not open public issues for vulnerabilities.

## Sending pull requests

Small, focused PRs land fastest. The tighter the scope, the faster we ship it.

1. **Fork + branch.** Branch off `main`. Name the branch for what it does: `fix/repl-history-truncation`, `feat/slack-skill`, `docs/onboarding-walkthrough`.
2. **Write the code.** Match the existing style. Run `pnpm exec biome format --write .` before committing.
3. **Type-check, lint, test.** `pnpm typecheck`, `pnpm lint`, and `pnpm test` must all be clean — this is the same gate CI runs across Node 20 / 22 / 24.
4. **Build if you touched a plugin.** `pnpm build` compiles each skill's `tools.ts` to the `tools.mjs` the loader ships (so executable skills work on the Node 20 floor); it must succeed, and the loader suite in `pnpm test` covers plugin registration.
5. **Open the PR.** In the description: what changed, why, and how you tested it.

We review with three goals: it works, it doesn't break what already worked, it doesn't add complexity that doesn't earn its keep.

## Code style

- TypeScript strict mode. No `any` unless you have a comment explaining why.
- ESM imports with `.js` extension (the TypeScript convention for native ESM).
- Prefer pure functions over classes. Use classes when state is real.
- One file per concept. If a file is over 500 lines, it might want to split.
- Comments explain *why*, not *what*. Self-explaining code preferred.

## Plugin contributions

Plugins live under `skeleton/SKILLS/<name>/`. Copy any existing v2 plugin (`google`, `github`, `web-search`, `wearables`) as the template:

- `manifest.yaml` — declares the skill's name, vault keys, env keys, and tool names
- `SKILL.md` — the prompt the agent reads to know when to use the plugin
- `setup.md` — human walkthrough that the runner prints during `meridian skills setup`
- `tools.ts` — exports `createTools(ctx)` (and optionally `setup(ctx)` for interactive walkthrough)

A working plugin compiles cleanly, registers its tools at boot, and walks the operator through paste-and-validate setup without ever writing bad credentials to the vault. See `skeleton/SKILLS/web-search/tools.ts` for the smallest working example, and **[docs/skill-authoring.md](docs/skill-authoring.md)** for the full end-to-end walkthrough (manifest, `createTools(ctx)`, credentials, the `tools.ts` → `tools.mjs` build, install, verify).

## What we will and won't merge

We will merge:
- Bug fixes with a reproduction
- New plugins that follow the SKILL v2 contract
- Documentation improvements
- Performance work with a measurement
- Refactors that delete code

We probably won't merge:
- Adding dependencies that duplicate something we already use
- Big architectural rewrites without a discussion in an issue first
- Vendor lock-in (e.g. wiring a specific cloud provider into the runtime)

## Questions

Open a [GitHub Discussion](https://github.com/Rezzyman/meridian/discussions) or DM [@rezzyman](https://x.com/rezzyman) on X.

By contributing, you agree your contributions are licensed under MIT (the project license).
