---
name: commitment-ledger
description: Capture every commitment the user makes across every channel. Append-only.
category: essentials
runtime: markdown
trigger: detected commitment language in any conversation channel
sources: [conversation transcript, cortex_encode]
output_format: structured row appended to MEMORY/decision-logs/commitments.md
---

Watch for commitment language: "I will", "we will", "by Friday", "let me get back to you", "I owe you", "we should".

When detected:
1. Encode the commitment via `cortex_encode` with priority 3 and `channel:commitment`.
2. Append a row to `MEMORY/decision-logs/commitments.md`:
   - date, commitment text, who was promised, due date (parsed if mentioned else "open"), related stakeholder, channel
3. If the user asks "what did I commit to this week", read this file directly.

Never edit prior rows. Append only. The ledger is a record, not a draft.
