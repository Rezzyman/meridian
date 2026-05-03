# Setup: github skill

The github skill talks to the GitHub REST API using the operator's
**personal access token** (PAT). No GitHub App, no OAuth flow, no
"connect with GitHub" web dance. Just a token.

## Step 1 — Create a personal access token

You have two choices. Fine-grained tokens are recommended.

### Option A: Fine-grained PAT (recommended, scoped per-repo)

1. Go to **https://github.com/settings/personal-access-tokens/new**
2. **Token name:** `meridian-<your-agent>` (e.g. `meridian-aria`)
3. **Expiration:** 90 days (or longer; you'll see warnings before expiry)
4. **Repository access:**
   - "All repositories" if your agent should see everything you own
   - Or pick specific repos
5. **Permissions** — set these **Repository** permissions to **Read and write**:
   - Issues
   - Pull requests
6. Set these to **Read-only**:
   - Contents
   - Metadata
   - Commit statuses
7. Click **Generate token**
8. Copy the token (starts with `github_pat_`). It's shown ONCE.

### Option B: Classic PAT (faster, broader scope)

1. Go to **https://github.com/settings/tokens/new**
2. Select scopes: `repo` and `read:user`
3. Generate. Copy the token (starts with `ghp_`).

## Step 2 — Run the skill setup

```
meridian skills setup github
```

The walkthrough will:

1. Ask you to paste the PAT
2. Test it with a `GET /user` call to verify it's valid
3. Optionally ask for a default repo (e.g. `Rezzyman/meridian`)
4. Store everything encrypted in the vault under `skill.github.*`
5. Print `github configured.`

## Step 3 — Restart the gateway

```
systemctl restart meridian-gateway-<your-agent>
```

Now in chat:

> "any open PRs on meridian?"
> "what issues did Stormy file this week?"
> "comment on issue 42: looking at this now, will reply EOD"
> "find every place we reference NEBUCHADNEZZAR_MAX in the cortex repo"
> "what's everything assigned to me right now?"

## Token expiry

Fine-grained tokens expire (90 days by default). The skill will emit a
warning when a call fails with 401. Re-run `meridian skills setup github`
to drop in a fresh token.

## Security

The PAT is stored AES-256 encrypted in the agent's vault. It's never
echoed in logs or model output. If the agent's machine is compromised,
revoke the token at **https://github.com/settings/personal-access-tokens**
and rotate.

## Multi-account note

Each Meridian agent gets its own PAT. To watch a different person's GitHub
activity, run the setup walkthrough on a different agent home (e.g. a
dedicated `team-watcher` agent) with a token from THAT person's account.
We do not share PATs across agents (per Meridian's per-agent isolation rule).
