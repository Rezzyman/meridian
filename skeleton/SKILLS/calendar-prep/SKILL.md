---
name: calendar-prep
description: Produce a one-page brief for any upcoming meeting from calendar, prior interactions, and open threads.
category: essentials
runtime: markdown
trigger: user mentions an upcoming meeting, or a meeting starts within the next two hours
sources: [calendar connection, inbox connection, cortex_recall]
output_format: markdown one-pager
---

Before any meeting, surface:

- **Meeting**: title, time, attendees
- **Why this meeting exists**: one sentence
- **What attendees want**: one sentence per attendee
- **What the user wants**: one sentence
- **Last touchpoint**: when, what was discussed, what was promised, by whom
- **Open commitments**: anything anyone owes anyone
- **Suggested opener**: one line

Cap at three hundred words. The brief is read in the elevator, not the conference room.
