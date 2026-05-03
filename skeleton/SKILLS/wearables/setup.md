# Setup: wearables skill

The wearables skill is the category — pick which wearable lifelog provider you want to plug in. The current release has a working adapter for **Limitless Pendant**; the architecture is in place for Plaud, Bee, Friend, and Meta Ray-Ban (adapters pending; track at github.com/Rezzyman/meridian/issues).

## 1. Pick a provider

```
meridian skills setup wearables
```

You'll see a numbered list of supported providers. Pick the one you have. The walkthrough handles the rest.

## 2. Add your API key

Working providers (today: Limitless) read their key from your agent's `.env` file. The walkthrough tells you exactly which env var to set:

| Provider | Env var | Where to get it | Status |
|---|---|---|---|
| Limitless Pendant | `LIMITLESS_API_KEY` | https://app.limitless.ai/settings/developer | working |
| Bee Pendant | `BEE_TOKEN` | run `bee login` then `bee proxy` on this host; default proxy URL is `http://127.0.0.1:8787` (override with `BEE_API_URL`) | working |
| Plaud Note | `PLAUD_API_KEY` | https://www.plaud.ai/pages/developer-platform | private beta, waitlist only (adapter lands when public API ships) |

Add the key to `~/.meridian/<agent>/.env`:

```
LIMITLESS_API_KEY=lmt_...
```

The .env is chmod 600 by default.

## 3. Set the passphrase guard

The wearables skill carries access to your most personal context — every ambient conversation it captures. The passphrase guard means even if the agent is socially engineered or compromised, transcripts cannot be pulled without your explicit OK.

The setup walkthrough prompts for a passphrase, hashes it (sha256), and writes the hash to your agent's encrypted vault. You'll type the passphrase ONCE per 30-minute window when the agent goes to pull (or every call if you set `sessionWindowMinutes: 0` in the manifest).

## 4. Restart the gateway

```
systemctl restart meridian-gateway-<agent>     # production
# or just exit and re-launch the REPL
```

## 5. First pull

In chat:

> "pull my last 7 days of lifelog transcripts"

The agent will:

1. Realize it needs to call `wearables_pull`
2. Hit the passphrase guard → ask you for the passphrase
3. You reply with `/auth wearables <your-passphrase>`
4. Agent re-calls `wearables_pull` → fetches from each configured provider → encodes each transcript into CORTEX
5. Reports back: per-provider seen / encoded / skipped, date range, any errors

Subsequent pulls within 30 minutes will not require the passphrase again.

## Adding a new provider

If you build a working adapter for one of the stubbed providers (or a new one entirely), open a PR. The contract is the `WearableProvider` interface in `tools.ts`:

- `id`, `displayName`, `developerUrl`
- `authType` (`env-api-key` / `vault-api-key` / `oauth`)
- `resolveCredentials(ctx)` reads from env or vault
- `ping(creds)` validates the key
- `fetchByDate({ date, cursor, creds })` returns one normalized day of lifelogs

Register your provider in the `PROVIDERS` array. The setup walkthrough, vault layout, and pull tool all flow through automatically.
