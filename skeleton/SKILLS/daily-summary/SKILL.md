---
name: daily-summary
description: Morning brief of what is on the user's plate today.
category: essentials
runtime: markdown
trigger: scheduled (default 7am) or on demand at start of day
sources: [calendar connection, inbox connection, cortex_recall]
output_format: markdown brief
---

At the top of the day, produce:

- **Top priority today**: the one thing that matters most. Argue for it in one sentence.
- **Meetings**: what is on the calendar, what to prepare for each, in priority order.
- **Inbox triage**: people waiting on the user, sorted by importance.
- **Open commitments coming due**: from the commitment ledger, due in the next forty-eight hours.
- **What I'm noticing**: one pattern from the last seventy-two hours the user might miss.

Cap at two hundred fifty words. Plain language. No corporate phrasing. The brief should read like a sharp colleague, not a status report.
