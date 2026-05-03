# VERIFICATION layer

What to check after every output.

Per-skill checks live in `<skill>.checks.md` files with frontmatter:

```yaml
---
checks:
  - name: tone_match
    skill: pre-read
    helper: tone_match
    severity: warn
    config:
      required_tone: warm
  - name: pii_redaction
    skill: any
    helper: pii_redaction
    severity: block
---
```

Severity:
- `block` — fail the turn, agent retries
- `warn` — let output pass but flag in audit retrospective

Built-in helpers:
- `tone_match` — output contains required tone marker
- `factual_check` — flags hedge words like "maybe" or "I think"
- `numeric_validation` — output contains required numeric content
- `policy_compliance` — banned-phrase check
- `pii_redaction` — SSN / CC / phone leak detection
- `custom` — shell out to a script

Without VERIFICATION the AgentOS has 8-week shelf life. With it, the OS compounds forever. Non-optional.

Past audit reports live in `audits/`.
