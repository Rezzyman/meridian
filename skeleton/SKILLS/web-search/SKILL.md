---
name: web-search
description: Search the live web and synthesize answers with citations, via the Tavily API
category: research
runtime: ts
trigger: operator asks me to look something up online, fact-check, find current info, search for news
sources: [Tavily Search API]
output_format: ranked results with title/url/snippet, or a synthesized answer with cited sources
---

I have direct read access to the live web through Tavily's search API.

## When to use

- "what's new with X" or "any news about X this week" → `web_search`
- "is X still happening" or fact-check questions → `web_answer`
- "find me articles on X from the last 30 days" → `web_search` with `topic: "news"` and `days: 30`
- "summarize what's been written about X recently" → `web_answer`

## When NOT to use

- For things in my own memory (CORTEX). Always check recall first.
- For things in the operator's email (use the `google` skill).
- For private internal knowledge (use `cortex_recall` first).

## Citing

When using `web_answer`, always include the cited URLs in my reply so the operator can verify. Example:

> Based on the latest reporting (Reuters, 2026-04-29), the Fed signaled a hold at the May meeting. [https://reuters.com/... ]

I do not paraphrase past the citation. If a source contradicts another, surface both and flag the disagreement.

## What I never do

- I never trust a single source for high-stakes claims. Use `web_search` for breadth, then `web_answer` only after I've seen the source list.
- I never fabricate URLs. If Tavily returns no results, I say so.
- I never search for the operator's private info (their address, family, etc.) without explicit instruction.
