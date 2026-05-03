# Setup: google skill

This skill talks to Gmail, Calendar, and Drive through the **bundled `gog`
CLI** (steipete/gogcli, MIT). The first time you set it up Meridian
downloads the right gog binary for your platform from GitHub Releases,
verifies its checksum, and ad-hoc signs it on macOS so Gatekeeper accepts
it. After that you authorize one or more mailboxes via OAuth.

Setup takes ~3 minutes the first time per mailbox. Tokens are stored in
your OS keychain (macOS Keychain on Mac, libsecret on Linux desktop, or
encrypted file storage on headless servers).

## Step 1 — Run the walkthrough

```
meridian skills setup google
```

The walkthrough will:

1. Resolve and (if needed) download gog into `~/.meridian/bin/gog-<version>`
2. Show you which mailboxes are already authorized for this agent's
   OAuth client bucket (named `<agent>-meridian` by default)
3. Offer to add a new mailbox — opens a browser to Google's consent
   screen, you click **Allow**, gog captures the refresh token and
   stores it in the OS keychain
4. Repeat step 3 for each mailbox you want this agent to see
5. Write the authorized account list into the agent's vault under
   `skill.google.accounts` so the model knows the addressable surface
6. Print `google configured.`

## Step 2 — (macOS only, first-run) Authorize Keychain access

The first time the new gog binary tries to read a stored token, macOS
will pop up a Keychain prompt asking whether to allow access. Click
**Always Allow**. After that you never see the prompt again.

If you skip this and it gets killed silently, you'll see "round trip:
oauth2: unauthorized_client" errors. Fix: from a terminal, run
`~/.meridian/bin/gog-<version> auth list` interactively once, click
Always Allow, then retry.

## Step 3 — (Headless servers / VPS) Use file-backed storage

On a headless Linux box with no D-Bus / libsecret, set these in the
agent's `.env`:

```
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=<long random string>
```

Meridian's vault holds `GOG_KEYRING_PASSWORD` for you — the bootstrap
script in `scripts/setup-vps.sh` generates one on first install.

## Step 4 — Restart the gateway

```
systemctl restart meridian-gateway-<your-agent>     # production
```

Now in chat:

> "what's on my calendar today?"
> "search you@example.com for any new emails from a sender this week"
> "find that doc about Q3 plans"
> "draft a reply to Mark Wilson saying I'll get back to him Friday"

## Migrating from an existing gog setup (e.g. OpenClaw)

If you already have authorized mailboxes in `gog auth list` under
different client bucket names (e.g. `legacy-access`, `default`,
`service-account`), you don't need to re-auth. Each entry in
`skill.google.accounts` can specify its own `client` field:

```json
[
  { "email": "you@example.com",      "client": "legacy-access" },
  { "email": "you@personal.com",     "client": "default" },
  { "email": "team@your-domain.com", "client": "service-account" }
]
```

The setup walkthrough offers `--reuse-existing` to import these from
your existing `gog auth list` output instead of running new OAuth flows.

## Multi-mailbox usage

Every tool takes an `account` parameter. Example:

> "search team@your-domain.com for invoices newer than 7 days"

Without an explicit `account`, tools default to the **first authorized**
account in `skill.google.accounts` (the operator's primary).

## What the skill never does

- Never SENDS email without explicit operator approval (`gmail_draft`
  creates drafts; there is no `gmail_send` without an explicit confirm flag)
- Never DELETES calendar events or files without explicit operator approval
- Never shares Gmail / Calendar / Drive contents outside the operator's session
- Never reads from a mailbox NOT in `skill.google.accounts`
