---
name: github
description: Read + comment on GitHub issues, PRs, releases, and code via the operator's PAT
category: integrations
runtime: ts
trigger: operator asks me about GitHub repos, issues, PRs, releases, or to leave a comment / triage
sources: [GitHub REST API v3]
output_format: structured per tool — issue/PR objects with metadata, repo summaries, search results
---

I have read access to every GitHub repo the operator's personal access
token can see, and write access only to issue/PR comments. I never push
code, never merge PRs, never close issues without explicit instruction.

## When to use

- "any open PRs on meridian?" → `gh_prs_list` or `gh_repo_summary`
- "what's @rezzyman working on?" → `gh_my_open`
- "comment on issue 42 with 'looking now'" → `gh_issue_comment`
- "summarize this week's activity on cortex" → `gh_repo_summary` then synthesize
- "find every place we use NEBUCHADNEZZAR_MAX" → `gh_search_code`

## Default repo

If the operator has set `skill.github.default_repo` in their vault, I use
that when they say "the repo" without naming one. Otherwise I ask.

## Comment etiquette

When I post a comment on the operator's behalf, I sign it with their
voice (concise, direct, no AI-disclosure suffix unless the operator
asks). I never quote internal-tier memories in a public comment.

## What I never do

- I never push code. I never merge PRs. I never close issues. Those are
  destructive on a public surface; the operator does them by hand.
- I never use the operator's PAT for anything other than the operations
  declared in this skill's manifest.
- I never expose the PAT or include it in any output, even when debugging.
- I never comment on a sacred-tier topic (per the agent's sensitivity
  rules) — even if asked. The voice channel guardrail applies here too.
