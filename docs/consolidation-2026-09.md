# Consolidation record, September 2026

Before 2026-09-22 Meridian's source lived in five divergent copies. This branch
puts them back into one `main`. Nothing was dropped; every disposition is listed.

## Sources and dispositions

| Source | Head | Disposition |
|---|---|---|
| `origin/main` | `cf8783b` (2026-07-10) | Base of `consolidate/2026-09`. |
| `origin/stormy-governed-release-20260731` | `3b22a8a` (2026-07-31) | Fast-forward merge. Descendant of origin/main. |
| VPS-only `ops/autonomy-control-plane-20260731` from `/root/meridian-autonomy-control-plane` | `289c934` (2026-07-31) | Fast-forward merge via a git bundle. Pushed to origin as an archive branch. `ops/wearables-owner-gate-20260731` on the same repo is an ancestor and needed nothing. |
| VPS-only snapshot `/opt/meridian/releases/loop-20260813c` (no git) | 2026-08-13 | Diffed file by file. Eleven files differed; ten were the August Loop adapter files that the Mac work below supersedes (the Mac version is a strict superset: it adds device revocation, look/PTT/text turns, and weather). The eleventh, `src/safety/error-firewall.ts`, carried an "ARLO OPERATOR PATCH 2026-08-08" that emptied the brand-redaction list because it rewrote the operator's own name in Arlo's replies. Not imported as-is; recorded as a defect (redaction must be gated by sender trust) for the hardening pass. |
| Mac uncommitted work (2026-09-03) | committed as `314b025` on `wip/loop-adapters-20260903`, tagged `pre-consolidation-mac-20260917` | Merged in `10d4c98`. Seven conflict hunks in five files, all resolved by keeping both sides. `router.ts` now stacks the control-plane streaming workaround with the Claude 5 temperature strip. |
| `origin/agent/routexor-first-onboarding` | `c1328d7` (2026-08-04) | Merged in `b1c3783`. |
| Dist-only builds `loop-20260813e` and `arlo-repair-20260818` | 2026-08-13 and 08-18 | No source anywhere. A string-literal diff against the consolidated build recovered two fixes, reimplemented in `dd25735`: the automation prompt's tri-state recall marker with no memory ids in briefs, and `maxSteps: 24` in the turn loop. All other production-only strings were doctor and onboarding copy already superseded on the chain. |

The last commit on the branch, `876ba08`, is the formatter applied to 135 files with no logic change, kept separate so later diffs stay readable.

## Gate at the tip

`pnpm typecheck` clean, `biome lint` one pre-existing warning, `pnpm test` 759 pass and 0 fail on three consecutive runs after one flaky timeout in `test/ingest/file-ingest.test.ts` ("marks a document .failed when every chunk fails to encode", 5 second budget). That flake is on the hardening list.

## Defects surfaced during consolidation

- Brand redaction in `src/safety/error-firewall.ts` rewrites the operator's own name for operator-only agents. Gate it by sender trust and channel.
- `runTurn` requests 1500 recall tokens under an 8 second cap. On Arlo's CORTEX, recall takes 10 to 16 seconds at 2000 tokens and about 1 second at 900 or less (measured by the voice session, 2026-09-22). Add a per-agent recall budget and default Arlo to 900.
- The heartbeat in the August production build used a one-line self-check prompt; the chain has the evidence-driven governed heartbeat from the control-plane branch. The chain wins, but the governed version has never run in production.

## Preservation artifacts

`~/meridian-consolidation/` on the Mac (outside iCloud) holds the control-plane bundle, the `loop-20260813c` source tarball, and both dist-only builds. Keep until the Arlo soak completes.
