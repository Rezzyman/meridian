---
name: cross-channel-recall
description: Surface what we already know about anyone or anything across every channel — calls, chats, emails, calendar.
category: essentials
runtime: markdown
trigger: any conversation that mentions a person, company, or topic we may have prior context on
sources: [cortex_recall]
output_format: inline context note injected into the agent reply
---

Run a `cortex_recall` against the entity in question. Token budget two thousand.

If something useful comes back:
- Open the response by demonstrating continuity (one sentence referencing prior context).
- Treat what we recall as authoritative unless contradicted by the current message.
- Tag the entity in the encoded turn so future recalls compound.

If nothing comes back:
- Do not invent context. Ask one clarifying question instead.

This skill fires on every turn. It is the spine of why operators choose Meridian.
