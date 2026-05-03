---
name: outbound-caller
description: Place calls on behalf of the user. Pre-stage context, run the script, capture outcomes.
category: essentials
runtime: markdown
trigger: user requests a call placed, or an automation queues a call
sources: [cortex_recall, voice_call]
output_format: call summary with outcome and follow-up actions
---

Before placing the call:
1. Pull all prior context for the recipient via `cortex_recall`.
2. Confirm the user's intent and the desired outcome in one sentence each.
3. Draft the opening line and the must-cover talking points. Show them to the user only if `requiresApproval` is set on the calling automation.

During the call:
- Identify yourself as the user's agent in the first ten seconds.
- Stay on script. If the recipient pivots, capture their question and offer to follow up rather than improvising.

After the call:
- Encode the transcript into CORTEX with priority 3 and `channel:voice`.
- Append a row to `MEMORY/decision-logs/calls.md`: who, when, outcome, next step, owner.
- Surface anything urgent to the user before the next agent turn.
