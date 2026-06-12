# Meridian Agent Builder

Build your own Meridian agent in a few clicks — no terminal, no config files.
A guided wizard for non-technical people that produces a **100% standard
Meridian agent**: real seven-layer home, private local memory, the runtime's
memory-poisoning screen on by default, and a live chat the moment it's built.

This app is a face, not a fork. It contains **no agent runtime**: agents are
scaffolded by driving the repo's own `initAgent` / `composeIdentity` /
onboard-format writers through a small bridge script, and conversations run
through the repo's own gateway (`meridian gateway`, spawned per agent). If the
runtime improves, the builder improves.

## Launch

```bash
cd apps/agent-builder
pnpm install
pnpm dev          # → http://localhost:3000
```

Requirements:

- Node 20+ and pnpm (same as the repo).
- **A model to think with** — either [Ollama](https://ollama.com) running
  locally (`ollama pull qwen2.5:3b` is enough; the wizard auto-detects and
  picks the best installed model), or one API key (Anthropic / Groq / OpenAI /
  OpenRouter) pasted in the wizard's last step. Memory needs **no** keys or
  servers: agents are created with `MERIDIAN_MEMORY_PROVIDER=embedded`.
- One-time: the repo's `better-sqlite3` native binding must be built (pnpm 10
  skips dependency build scripts by default, and the gateway's session store
  needs it):

  ```bash
  cd <repo root>/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install
  ```

## What the wizard does

1. **Choose its job** — five starter personas (chief of staff, receptionist,
   sales qualifier, concierge, personal assistant) described in plain language.
2. **Make it yours** — name, who it works for, tone, what to always remember,
   what to never share (written to `operator.sensitivity.sacredTopics`).
3. **Channels & skills** — web chat now; Telegram/voice as toggles (they
   activate when tokens are added later). Skill cards map to the bundled
   skill dirs (`web-search`, `github`, `google`); unselected ones are removed
   from that agent's home.
4. **Build** — the bridge runs the real `meridian init` path (non-interactive,
   embedded memory), writes IDENTITY/CONTEXT files in the exact formats
   `meridian onboard` produces, and writes a model chain that actually works
   on this machine (detected Ollama models, or your key).
5. **Meet it** — a gateway starts for the agent (loopback only) and the chat
   streams through a server-side SSE proxy (no CORS, no tokens in the
   browser). Tell it something, refresh the page, restart the gateway — it
   remembers.

Agents land in `~/.meridian/<slug>/` and work identically from the CLI:
`MERIDIAN_AGENT=<slug> meridian gateway` (or the REPL). The disabled
**Deploy to Meridian Cloud →** button is the placeholder for the hosted path.

## Layout

```
bridge/build-agent.ts   runs under the repo's tsx; imports src/cli + src/config
src/lib/                personas, system probe (Ollama/keys), build orchestrator,
                        gateway process manager, agent summaries
src/app/api/            agents CRUD, gateway start/stop, chat SSE proxy, system
src/app/                / (home) · /new (wizard) · /agents/[slug] (chat room)
```

## Notes for maintainers

- Gateways are spawned from the repo **source** (`tsx src/cli/main.ts gateway`)
  so builder agents always run the checked-out runtime, including its
  safety defaults. PIDs/ports live in `~/.meridian/.builder/gateways.json`
  (dot-dir: invisible to the CLI's agent listing); logs in
  `~/.meridian/<slug>/logs/builder-gateway.log`.
- The embedded `.env` template writes empty placeholders (`OPENROUTER_API_KEY=`);
  dotenv exports empty strings, which fail `AgentEnvSchema`'s min-length checks
  and crash the gateway at boot. The bridge comments those lines out after
  init. Worth a runtime fix later (treat `''` as undefined in the loader);
  the builder does not patch the runtime by design.
- Root `pnpm lint` excludes `apps/` (see root `biome.json`); this package owns
  its own toolchain (`pnpm typecheck`, `next build`).
