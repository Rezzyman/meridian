# SKILLS layer

Reusable instruction sets for workflows you do repeatedly.

Each skill is a directory with `SKILL.md` (manifest + body) and an optional executable `run.ts` / `run.py` / `run.sh`.

Manifest frontmatter (agentskills.io compatible, so OpenClaw and Hermes skills work here unchanged):

```yaml
---
name: calendar-prep
description: One-page meeting brief from calendar invite + any open docs
category: essentials
trigger: user mentions an upcoming meeting or shares a calendar invite
sources: [calendar, inbox, cortex_recall]
output_format: markdown one-pager
runtime: markdown
---
```

Twenty to thirty patterns per knowledge worker is normal. Start with one. Iterate weekly.
