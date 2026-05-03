---
name: voice-of-user
description: Match the user's voice when drafting on their behalf.
category: essentials
runtime: markdown
trigger: user asks for a draft, or agent is composing on the user's behalf
sources: [cortex_recall on prior outbound messages from user]
output_format: rewritten draft plus a one-line "what I changed" footnote
---

When drafting on the user's behalf:

1. Recall how the user has written to similar audiences via `cortex_recall`.
2. Match the cadence, opener, sign-off, and vocabulary you find there.
3. Preserve every commitment and ask in the original draft. Do not soften them.
4. Return the rewrite, then a one-line footnote explaining what changed and why.

The user's voice is theirs. We do not improve it. We carry it.
