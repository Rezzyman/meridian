---
name: wearables
description: Pull ambient lifelog transcripts from a wearable lifelog provider (Limitless, Bee; Plaud pending) and encode them into CORTEX.
category: ingestion
runtime: ts
trigger: operator asks to "pull lifelogs", "sync my wearable", "catch up on transcripts"
sources: [Limitless Pendant, Bee Pendant, Plaud Note (waitlist)]
output_format: structured ingest summary + count of new memories
---

I have tools to pull ambient lifelog transcripts from a wearable
provider and encode them into the operator's CORTEX. The skill is the
**category** — multiple providers plug in through a common adapter
interface. A single operator can configure one provider, multiple
providers, or none.

## When to use

- Operator says "pull lifelogs", "sync my wearable", "catch me up on transcripts", or anything asking me to fetch recent ambient recordings.
- I should NEVER pull without an explicit request. This is a high-trust action that captures private conversation context.

## How it works

The `wearables_pull` tool takes a date range, an optional provider, and
a passphrase. The passphrase guard is set per-agent during
`meridian skills setup wearables`. A successful passphrase grants a
30-minute session for further pulls without re-prompting.

If `provider` is not specified, the tool pulls from every configured
provider. Each provider's adapter knows how to talk to its API and
returns a normalized lifelog stream that becomes one CORTEX memory per
transcript, tagged with `wearables:<provider>:<date>:<id>` so future
recall can cite the source device.

Ingest is idempotent — a re-pull does NOT duplicate existing memories
(we check by lifelog id). The dedup map is shared across providers so
the same id from two providers doesn't double-encode.

## Supported providers

- **Limitless Pendant** — working (api.limitless.ai, env `LIMITLESS_API_KEY`)
- **Bee Pendant** — working via local `bee proxy` (env `BEE_TOKEN`, optional `BEE_API_URL` override; default `http://127.0.0.1:8787`)
- **Plaud Note** — adapter pending. Plaud Developer Platform is in private beta as of May 2026; waitlist at https://www.plaud.ai/pages/developer-platform.

Friend AI and Meta Ray-Ban Stories are NOT in the registry today: Friend's transcripts are phone-local with no cloud API, and Meta's Wearables Device Access Toolkit is partner-only and exposes live sensors not stored transcripts.

To see the live status from the agent home, run `wearables_status`.

## What I tell the operator

When I'm about to pull, I say which provider(s) and what date range I'm
fetching. After the pull completes, I report:

- Per-provider seen / encoded / skipped counts
- The date range covered
- Any errors (with actual error text, not "something went wrong")

If the passphrase is required and I don't have a session, I ask the
operator to run `/auth wearables <passphrase>` rather than pretending
the pull worked.
