# Setup: web-search skill

The web-search skill uses the **Tavily Search API** for real-time web
results with built-in answer synthesis. Tavily has a generous free tier
(1,000 searches/month) so most personal Meridian agents will never see
a bill.

## Step 1 — Get a Tavily API key

1. Go to **https://tavily.com/**
2. Sign up with your email (no credit card required for the free tier)
3. From the dashboard, copy your API key (starts with `tvly-`)

## Step 2 — Run the skill setup

```
meridian skills setup web-search
```

The walkthrough will:

1. Ask you to paste the Tavily API key
2. Test it with a no-op search to verify the key works
3. Store it encrypted in the agent's vault under
   `skill.web-search.tavily_api_key`
4. Print `web-search configured.`

## Step 3 — Restart the gateway

```
systemctl restart meridian-gateway-<your-agent>     # production
```

Now in chat:

> "what's the latest on the Fed rate decision?"
> "search for any news about Stormy Knight from the last 7 days"
> "find articles about CORTEX cognitive memory architectures"
> "fact-check: did the Avalanche win last night?"

## Tier limits

The free tier gives you 1,000 searches/month. If you hit that limit,
the skill returns a clean error pointing at the upgrade page; nothing
crashes. Production agents handling >100 searches/day should grab the
$20/month tier.

## Privacy note

Tavily logs your queries server-side for ranking research. For
sensitive research, route through a self-hosted SearxNG endpoint
instead by setting `skill.web-search.provider: searxng` in the
manifest (planned for v0.2).
