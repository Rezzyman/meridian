# Meridian web chat

A single-file browser chat UI for talking to a running Meridian gateway. No build step, no dependencies, no framework. Open the HTML file in a browser, paste your gateway URL and token, and start chatting.

## Quick start

```bash
# 1. Start your gateway
meridian gateway

# 2. Open chat.html in your browser
open skeleton/web/chat.html       # macOS
xdg-open skeleton/web/chat.html   # Linux
start skeleton/web/chat.html      # Windows
```

## Settings

The first time you open the page, the settings panel asks for two values:

- **Gateway URL** — defaults to `http://127.0.0.1:18889`. If your gateway is behind a reverse proxy or on a different host, paste the full base URL (no trailing slash).
- **Gateway Token** — value of `MERIDIAN_GATEWAY_TOKEN` from your agent's `.env`. Used as `Authorization: Bearer <token>` on every request.

Both are stored in your browser's `localStorage`. Nothing leaves the page.

## What it does

- Sends every message to `POST <gateway>/chat` with the bearer token.
- Renders the agent's `reply` as a chat bubble.
- Surfaces gateway errors directly (no silent failures).
- Shift+Enter for newline, Enter to send.
- Auto-grows the input box up to 200px.
- Dark theme by default; respects `color-scheme`.

## Hosting

This file is intentionally portable:

- **Local file**: open with `file://` — works as-is. `localStorage` is per-origin, so each browser keeps its own settings.
- **Static host**: drop on Vercel / Netlify / Cloudflare Pages / S3 + your operator points it at their own gateway. The HTML has no server needs.
- **Behind your own auth**: if you want to gate access (e.g. expose this page behind Clerk or a basic-auth proxy), just put it behind whatever reverse proxy you already use.

## What it doesn't do (yet)

- No streaming. Each turn round-trips as a single response. The agent's reply lands all at once when the LLM finishes generating. Streaming via Server-Sent Events is on the roadmap.
- No file upload. Drag-and-drop ingest is a separate feature.
- No persistent conversation across page refreshes (the gateway has its own session store; the page just doesn't replay it on reload).
- No voice. The voice channel goes through VAPI; this page is for chat only.

The full feature inventory is in [`ROADMAP.md`](../../ROADMAP.md).
