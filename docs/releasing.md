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
- `better-sqlite3` is a native dependency; npm uses its prebuilt binaries on
  common platforms (no build tools needed for most users).
