---
name: decision-memo
description: When a real decision is made, capture it. Append-only structured memo.
category: essentials
runtime: markdown
trigger: detected decision language during conversation
sources: [conversation transcript, cortex_encode]
output_format: structured row appended to MEMORY/decision-logs/decisions.md
---

When a decision is made (anything starting with "we decided", "we chose", "we are going with", "we are not doing"):

1. Encode via `cortex_encode` with priority 4 (decisions are high-salience).
2. Append a row to `MEMORY/decision-logs/decisions.md`:
   - date
   - decision (one sentence)
   - alternatives that were considered
   - rationale (one sentence, the actual reason)
   - owner (who is accountable for executing)
   - dependencies
3. If the same decision gets re-litigated later, surface the original entry.

Decisions that aren't written down get re-decided. We don't do that here.
