# Releasing Meridian to npm

Publishing is automated: **push a `v*` tag and CI builds, tests, and publishes**
`@aterna/meridian` to npm with provenance. One-time setup, then it's a tag-push.

## One-time setup

1. **Create an npm automation token** with publish rights to the `@aterna`
   scope (npmjs.com → Access Tokens → Generate → *Automation*). The `@aterna`
   org/scope must exist on npm and your account must be able to publish to it.
2. **Add it as a repo secret** named `NPM_TOKEN`
   (GitHub → Settings → Secrets and variables → Actions → New repository secret).

That's it. The [release workflow](../.github/workflows/release.yml) does the rest.

## Cutting a release

Before you bump: run `pnpm test` and update the **tests-passing badge** count in
`README.md` (and `README.zh-CN.md`) if it changed. It is a hardcoded number, so it
drifts unless you refresh it here; a stale count is a small but real trust ding on
the landing page.

```bash
# 1. bump the version (updates package.json + creates the commit + tag)
npm version minor          # or: patch | major | 1.2.0

# 2. push the commit and the tag
git push && git push --tags
```

The `v*` tag triggers `.github/workflows/release.yml`, which:

1. runs the full gate — `typecheck · lint · test · build`,
2. verifies the tag matches `package.json` version,
3. `npm publish --access public --provenance`.

If any step fails, nothing is published.

## After the first release

```bash
npm i -g @aterna/meridian      # global install
meridian demo                  # or: npx @aterna/meridian demo
```

## Notes

- The published tarball is lean (`bin`, `dist`, `skeleton`, `docs`, the READMEs,
  LICENSE) — see the `files` allowlist in `package.json`. Verify locally with
  `npm pack --dry-run`.
- `@aterna/quartz` (the commercial BSL memory layer) is **not** a dependency of
  the public package; the runtime lazy-loads it and falls back to CORTEX when it
  is absent, so the open-source install always works.
- **Zero native dependencies.** The session store is a pure-JS JSONL append log
  (`better-sqlite3` was removed in 1.2.1), so `npm i -g @aterna/meridian`
  installs cleanly on every platform and Node version with no build toolchain.
