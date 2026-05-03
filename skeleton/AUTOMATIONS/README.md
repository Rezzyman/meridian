# AUTOMATIONS layer

Things the agent runs when you are not watching.

Each `.cron` file has frontmatter:

```yaml
---
name: daily-brief
schedule: "0 7 * * *"
mode: draft
requiresApproval: true
audit: true
trustGraduation:
  minRuns: 10
  minApprovalRate: 0.95
---

Daily brief at 7am. Scans inbox + calendar + open docs.
```

Rules:
- Only automate workflows you have run manually enough to trust
- Start with `draft` mode (output goes to you for review, not to other people)
- Only flip to `direct` mode after `trustGraduation` thresholds are met
- Always log

Built-in:
- `dream-cycle.cron` — nightly CORTEX consolidation (2 AM)
- `weekly-audit.cron` — Sunday 4 AM retrospective
- `heartbeat.cron` — every 2 hours within active hours
