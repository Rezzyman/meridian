# CONNECTIONS layer

How the agent reaches real systems: email, calendar, Slack, Jira, Salesforce, databases, APIs.

`mcp.json` lists MCP servers the agent consumes. Each entry: `name`, `transport`
(`stdio` | `http` | `sse`), `command`/`args`/`env` (stdio) or `url`/`headers`
(http/sse), `enabled`, and `channels` — the per-channel gate for that server's
tools. **Voice is excluded by default**; list `"voice"` explicitly to arm a
server on the public phone line. Discovered tools surface to the model as
`mcp_<server>_<tool>`. Probe with `meridian mcp list`.

The reverse direction also exists: `meridian mcp serve` exposes THIS agent
(CORTEX recall, stats, health — encode with `--allow-encode`) to any MCP
client over stdio.

Each `<system>.config` declares:
- `mode: read | read-write` — Meridian defaults to `read` and refuses `read-write` without `--allow-write` at deploy time
- `audit: true` — audit-log every read and write
- `scopes: [...]` — least-privilege scopes for the underlying API

**Start read-only. Always.** Add write access only after you have watched the agent behave for weeks. The risk scales with the capability.
