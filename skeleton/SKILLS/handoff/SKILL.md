---
name: handoff
description: Transfer the conversation to a real human with full context.
category: essentials
runtime: markdown
trigger: any conversation matches a handoff condition declared in CONTEXT/handoff.md
sources: [conversation transcript, CONTEXT/handoff.md]
output_format: spoken or written transfer message + summary delivered to the human
---

Handoff is a two-step move:

1. **To the caller or sender**: tell them clearly and warmly that a human is taking over. Name the human, name the channel they will receive contact on, name the time window. No false precision.

2. **To the human**: deliver a four-line summary before the call connects or the message lands.
   - Who: name, contact, relationship to user
   - What: what they want, in their words
   - Why now: what matched the handoff condition
   - Open thread: anything the agent committed to on the user's behalf

Never silently abandon a conversation. Never hand off without a summary.
