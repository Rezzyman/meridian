# Comparing memory-poisoning posture across agent harnesses — a fair methodology

> **What this is.** A reproducible way to compare MERIDIAN's cross-session
> memory-poisoning defense against other agent harnesses **using only their
> publicly documented behavior** — never by cloning, running, or
> reverse-engineering their code. The output is a posture matrix, not a
> leaderboard, because the honest answer to "is harness X resistant to memory
> poisoning?" is usually *"they haven't published enough to say."*
>
> **What this is NOT.** It is not a benchmark of competitors. We do not execute
> anyone else's software, and we do not assert a security property of another
> harness that its own maintainers have not. A score here is a score of *what is
> publicly known*, with every cell traceable to a citation or marked unknown.

## Why "we ran them through MemPoisonBench" would be dishonest

MemPoisonBench (`scripts/mempoison/`) scores a harness's **recall-stage**
defense: it feeds a poison memory to the recall screen and checks whether the
directive still reaches the model. Running it against MERIDIAN is fair — it is
our code and our integration point. Running it against another harness would
require us to (a) obtain and run their code, (b) decide *for them* where their
"recall screen" is, and (c) wire our test into an integration seam we do not
own. Any number that came out would measure *our wiring of their code*, not
their defense. That is exactly the kind of unreproducible, self-serving
benchmark the security community (rightly) dismisses — see the Zep/Mem0 and
Mastra/LongMemEval disputes over judge models and harness variants. So we don't.

Instead: we invite **them** (or any third party) to run the open MemPoisonBench
catalog through their own harness, at their own integration point, and publish
the result. The catalog is version-controlled and portable for exactly this.

## The dimensions

Each is a yes/no/partial question about a *published, capability*, chosen
because it is what actually determines memory-poisoning resistance (derived from
the threat model in `docs/memory-poisoning.md` and the attack classes in the
independent research, arXiv 2603.11619):

| key | question |
|---|---|
| `recall_screen` | Is recalled long-term memory screened **before** it reaches the model? |
| `provenance_trust` | Does the harness distinguish **trusted vs untrusted** memory origin at recall? |
| `signed_provenance` | Is that trust **cryptographic** (key-bound), not a spoofable label/string? |
| `multilingual` | Are non-English / non-Latin standing directives detected? |
| `cluster_detection` | Is **gradual / cross-memory** subversion (no single poison string) detected? |
| `judge_tier` | Is there an optional model-judged semantic tier for what patterns miss? |
| `open_benchmark` | Is there an **open, reproducible** memory-poisoning benchmark for it? |
| `published_number` | Is there a **published poisoning-resistance result** (with method)? |

## The scoring rubric (deliberately conservative)

Every cell is one of:

- **yes** — public, checkable evidence the capability exists (a doc, a paper, a
  source file, a reproducible benchmark). For MERIDIAN this is an in-repo path
  anyone can read; for others it must be their own publication.
- **partial** — a weaker or related form exists (e.g. a sandbox that limits tool
  damage but does not screen memory content).
- **no** — public evidence it explicitly *lacks* the capability (e.g. an
  independent paper demonstrating the exact gap).
- **unpublished** — **no public evidence either way.** This is the honest
  default for a competitor on a dimension nobody publishes about.

**The load-bearing rule:** `unpublished` ≠ `no`. Absence of a published defense
is *not* proof of absence of a defense. A harness may screen memory in a way its
docs simply never mention. The matrix reports what is *knowable from the public
record* on a given date, and says so. The only claim we make affirmatively about
a competitor's *weakness* is one its own maintainers or a credible independent
paper has documented — and we cite it.

## What may be claimed from the result

Exactly one quantified, defensible headline falls out of this matrix as of
2026-06-11: **MERIDIAN is the only harness in the surveyed set with an open,
reproducible memory-poisoning benchmark and a published, signed-provenance +
multilingual recall-stage defense.** That is a statement about the *public
record*, fully reproducible by reading the cited sources, and it does not assert
that any competitor is insecure — only that none has published a comparable
defense or benchmark. If one does, this file gets a new column and the headline
changes. That is the point.

## Reproducing the matrix

```bash
npx tsx scripts/mempoison/compare-harnesses.mts
```

It reads `scripts/mempoison/harness-claims.json` (the cited evidence table) and
renders the posture matrix + per-harness notes + the disclaimer. To challenge a
cell: open the cited source, and if it is wrong or stale, send a PR editing the
JSON with a better citation. The data and the renderer are separate on purpose —
the argument is the *evidence*, not the code.

## Sources & freshness

Security posture for fast-moving OSS moves weekly; every claim in
`harness-claims.json` carries a `source` URL and an `asOf` date. The competitor
claims here are seeded from the verified findings of an independent strategy
research pass (notably arXiv 2603.11619 on cross-session memory poisoning, and
Mastra's open LongMemEval harness publication) and are explicitly marked
`unpublished` wherever that pass found no public evidence — which, for
memory-poisoning *defense* specifically, is the common case. Re-verify before
citing in any launch material.
