# CONNECTIONS layer

How the agent reaches real systems: email, calendar, Slack, Jira, Salesforce, databases, APIs.

`mcp.json` lists Meridian-compatible MCP servers the agent can call.

Each `<system>.config` declares:
- `mode: read | read-write` — Meridian defaults to `read` and refuses `read-write` without `--allow-write` at deploy time
- `audit: true` — audit-log every read and write
- `scopes: [...]` — least-privilege scopes for the underlying API

**Start read-only. Always.** Add write access only after you have watched the agent behave for weeks. The risk scales with the capability.
