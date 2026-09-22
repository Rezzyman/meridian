# Meridian governance guarantee

Meridian's governance promise is deliberately narrower than “the agent is
safe.” It is an enforceable runtime contract:

> For tools executed through Meridian's governed tool surface, the runtime
> decides before invocation using operator policy, sender trust, scoped human
> approval, and the turn call ceiling. A denied action is not invoked. Completed
> attempts produce locally signed, tamper-evident receipts. When Routexor is the
> model provider, provider requests are separately authorized against context,
> token, spend, repetition, and quarantine controls before provider invocation.

This is a guarantee about code paths and evidence, not model intent.

## Enforcement boundary

| Boundary | Enforced before side effect | Evidence |
|---|---:|---|
| Built-in and skill tools used by a normal turn | Yes | Meridian action receipt |
| MCP tools visible to a normal turn | Yes | Meridian action receipt |
| Direct VAPI tool execution | Yes | Meridian action receipt |
| Model calls through Routexor | Yes | Routexor execution receipt + trace ID |
| Direct provider calls | No Routexor spend/context guarantee | Meridian turn trace only |
| Code run outside Meridian or Routexor | Out of scope | None |

The Routexor trace header is captured only for the Routexor provider; Meridian
never invents a trace ID for a direct provider.

## Action policy order

1. Operator denylist.
2. Aggregate per-turn call ceiling.
3. Signed, session/tool/expiry/use/optional-argument-digest approval.
4. Trusted-sender requirement for privileged and MCP tools.
5. Allow.

The denylist and call ceiling cannot be bypassed by an approval. Approval grants
are one-use and persisted when consumed. Receipt arguments are represented by a
SHA-256 digest, not stored as plaintext.

## Receipt properties

Meridian action receipts are HMAC-SHA-256 signed with a per-agent 32-byte local
key created mode `0600`. Each receipt includes the previous receipt hash, making
the ordered local chain tamper-evident. `/receipts` displays recent receipts;
`SessionStore.verifyActionReceipt` and `verifyActionChain` verify integrity.

Routexor authorization receipts are persisted and HMAC-signed before a provider
call. Success or failure is reconciled afterward; an interrupted finalization
leaves the authorization record visible. Owner-scoped APIs retrieve and verify
receipts by trace ID.

## Fail-closed behavior

- A denied tool is never invoked.
- A governed Routexor key is rejected if its budget ledger is unavailable.
- A Routexor request is rejected if a required audit record cannot be persisted
  or signed.
- Context/token ceilings and per-run/daily/monthly spend are checked before the
  provider call; budget reservations are atomic under concurrency.
- Repeated identical requests trigger durable key quarantine.

## Explicit limitations

- Meridian's local action receipt is currently finalized after tool completion.
  A process or host crash during an allowed tool can leave an execution without a
  completion receipt. Routexor model authorization does not have this gap.
- HMAC receipts prove integrity to a holder of the agent key; they are not public
  signatures, remote attestation, or an external transparency log.
- A compromised host that can read both state and signing keys is out of scope.
- Direct-provider configurations forgo Routexor's spend, context,
  loop-quarantine, and provider-receipt controls.
- Policy constrains invocation, not whether an allowed tool is bug-free or a
  model's prose is factually correct.

These limits are benchmark inputs and roadmap items, not footnotes to hide.

## Reproduce

```sh
pnpm test
pnpm benchmark:governed
# installed package:
npx meridian-benchmark
```

See [`benchmarks/governed-agent-v1/`](../benchmarks/governed-agent-v1/) for the
vendor-neutral protocol and [`examples/golden/stormy/`](../examples/golden/stormy/)
for a locked-down high-stakes reference agent.
