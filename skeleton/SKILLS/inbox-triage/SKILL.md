---
name: inbox-triage
description: Sort the user's unread mail. Surface what needs attention. Draft replies for the rest.
category: essentials
runtime: markdown
trigger: user asks about email, or scheduled morning brief calls it
sources: [inbox connection, cortex_recall]
output_format: ranked list with suggested actions
---

Pull unread mail in `read-only` mode unless write access is explicitly granted.

Group into four buckets in this order:
1. **Action required from user.** Real ask, real deadline, real consequence.
2. **Awaiting response from someone the user is blocking.** Who, since when, suggested nudge.
3. **Drafts the user owes other people.** Pre-write each one.
4. **Noise.** Mark for archive but do not archive without confirmation.

Cap the surfaced bucket at five items. The user does not need to see twenty.
