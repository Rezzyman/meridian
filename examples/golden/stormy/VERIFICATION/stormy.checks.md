---
checks:
  - name: no-sensitive-identifiers
    skill: any
    helper: pii_redaction
    severity: block
    trigger: on_output
  - name: no-unsupported-certainty
    skill: any
    helper: policy_compliance
    severity: block
    trigger: on_output
    config:
      banned_phrases:
        - definitely caused by
        - guaranteed coverage
        - unquestionably code compliant
  - name: uncertainty-language
    skill: image-analysis
    helper: policy_compliance
    severity: warn
    trigger: on_output
    config:
      banned_phrases:
        - no limitations
---

# Stormy output gates

These checks are deliberately portable and contain no customer records.
