# Security policy

## Reporting a vulnerability

If you find a security issue in Meridian, **do not open a public GitHub issue**. Email the report to:

> **security@aterna.ai**

Include:
- A description of the vulnerability
- Steps to reproduce, or a proof-of-concept
- The Meridian commit hash or release tag where you observed it
- Your assessment of severity (low / medium / high / critical)
- Whether you are willing to be credited in the fix release

We acknowledge receipt within **48 hours** and aim to ship a patch within **14 days** for high-severity issues, faster for critical ones. We will keep you informed throughout.

## Scope

In scope:
- The Meridian runtime and CLI (`@aterna/meridian` package)
- The bundled plugins (`google`, `github`, `web-search`, `wearables`)
- The encrypted vault (`src/secrets/vault.ts`)
- The HTTP gateway (`src/gateway/server.ts`)
- The session store and ingest paths

Out of scope (report directly to the upstream maintainer):
- Vulnerabilities in third-party dependencies (file with the dep author; we will pull the patched version once available)
- Issues in CORTEX (report to [Rezzyman/cortex](https://github.com/Rezzyman/cortex))
- Issues in Quartz (proprietary; report directly to ATERNA AI)
- VAPI, Telegram, Tavily, or other integrated services

## Coordinated disclosure

We follow a 90-day disclosure window. We will work with you to publish details and credit only after a fix has shipped and operators have had a reasonable window to upgrade.

## Bug bounty

We do not currently run a paid bug bounty program. Credit in the release notes is the recognition we offer today. As Meridian matures, this may change.

## What an operator can do today

Until you upgrade to a patched release, Meridian's design provides several layers of defense:

- **Per-agent isolation.** Every agent has its own Neon DB, Voyage key, and OpenRouter key. A compromise of one agent does not bleed into another.
- **Encrypted vault.** All persisted secrets (API keys, OAuth tokens, passphrase hashes) are AES-256-GCM encrypted at rest. The vault key (`MERIDIAN_VAULT_KEY`) lives only in the agent's `.env` (chmod 600).
- **Passphrase guards.** Skills can mark sensitive operations as passphrase-required; the agent will refuse without a fresh authorization.
- **Voice-channel sacred-topic refusal.** The voice channel auto-refuses on a configurable list of sensitive patterns before any tool can be called.
- **Loopback gateway by default.** The HTTP gateway listens on `127.0.0.1` only. Public access is gated behind a reverse proxy with auth.

These do not replace patching. They reduce the blast radius while you upgrade.
