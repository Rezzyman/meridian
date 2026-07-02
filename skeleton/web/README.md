# Meridian web chat

A single-file browser chat UI for talking to a running Meridian gateway. No build step, no dependencies, no framework.

## Quick start (served from the gateway — zero config)

```bash
meridian gateway --web
# then open http://127.0.0.1:18889/ — the page auto-configures to this origin
```

`--web` (or `MERIDIAN_GATEWAY_WEB=1`) serves this file at `/` and `/chat.html`. Served that way, the page targets the origin it was loaded from, so there is no URL to paste. If your gateway has a `MERIDIAN_GATEWAY_TOKEN`, add it once in settings (or hand it over via the URL fragment below).

## Quick start (as a local file)

```bash
meridian gateway                  # 1. start your gateway
open skeleton/web/chat.html       # 2. macOS
xdg-open skeleton/web/chat.html   #    Linux
start skeleton/web/chat.html      #    Windows
```

Opened via `file://`, the page defaults to `http://127.0.0.1:18889` and asks for settings on first load.

## Auto-configuration via URL fragment

A hosting flow (or you) can hand the page its config in the hash:

```
https://your-host/chat.html#url=https://gateway.example.com&token=YOUR_TOKEN
```

Fragments never reach server logs or `Referer` headers. The page persists the values to `localStorage` and immediately strips the fragment from the address bar. Share token-bearing links only over HTTPS or localhost.

## Settings

- **Gateway URL** — where to send chat requests. Precedence: `#hash` param, then saved settings, then same-origin (when served over http/https), then `http://127.0.0.1:18889`.
- **Gateway Token** — value of `MERIDIAN_GATEWAY_TOKEN` from your agent's `.env`, sent as `Authorization: Bearer <token>`. Leave empty for a tokenless gateway (server-side auth is optional).

Both are stored in your browser's `localStorage`. Nothing leaves the page.

## What it does

- Streams every message from `POST <gateway>/chat/stream` (SSE) — deltas render live, tool calls surface as status notes, and the final `done` event replaces the buffer with the canonical post-processed reply.
- Falls back to blocking `POST <gateway>/chat` on older gateways (404 on the stream route).
- Surfaces gateway errors directly (no silent failures).
- Shift+Enter for newline, Enter to send; auto-grows the input up to 200px.
- Dark theme by default; respects `color-scheme`.

## Hosting

This file is intentionally portable:

- **From the gateway**: `meridian gateway --web` (same-origin, zero config). Note the gateway sends no CSP header for this page on purpose — the settings panel legitimately supports pointing at a different gateway, which a `connect-src 'self'` policy would break. Put a policy in front via your reverse proxy if you do not want that.
- **Local file**: open with `file://` — works as-is. `localStorage` is per-origin, so each browser keeps its own settings.
- **Static host**: drop on Vercel / Netlify / Cloudflare Pages / S3 and point it at your gateway (settings panel or `#url=` fragment).
- **Behind your own auth**: gate access with whatever reverse proxy you already use (Clerk, basic auth, etc).

## What it doesn't do (yet)

- No file upload. Drag-and-drop ingest is a separate feature.
- No persistent conversation across page refreshes (the gateway has its own session store; the page just doesn't replay it on reload).
- No voice. The voice channel goes through VAPI; this page is for chat only.

The full feature inventory is in [`ROADMAP.md`](../../ROADMAP.md).
