# Loop harness adapters

Loop's mobile API is intentionally independent of the agent harness. The app
continues to use these public contracts:

- `POST /v1/loop/pairings/redeem`
- `DELETE /v1/loop/pairings/current`
- `POST /v1/loop/turns`
- `aterna.loop.pairing.request.v1` / `aterna.loop.pairing.reply.v1`
- `aterna.loop.turn.v1` / `aterna.loop.reply.v1`

Changing the server-side harness does not require an iOS release, a pairing
schema migration, or device-token rotation.

`DELETE /v1/loop/pairings/current` accepts an empty request authenticated by
the current device's scoped bearer capability. It atomically removes only that
device-token association. The first deletion and retries for the same
digest-only revocation tombstone both return `204`; unknown, malformed, and
operator/bootstrap credentials receive the same generic `401`. The server
never stores or logs the raw bearer.

## Meridian as the Loop upstream

The sidecar reaches its harness over OpenAI-compatible
`POST /v1/chat/completions` on loopback. Meridian's gateway serves that route
(bearer = `MERIDIAN_GATEWAY_TOKEN`), so switching Loop from OpenClaw to
Meridian is a configuration change, not a code change:

1. Run a Meridian gateway for the Loop lane with
   `MERIDIAN_COMPLETIONS_ISOLATION=loop` in its environment. Every completion
   on that gateway is then tool-free and memory-write-free, which is the Loop
   contract's requirement regardless of what the sidecar sends.
2. Point the sidecar at it: `LOOP_UPSTREAM_URL=http://127.0.0.1:<port>`.
3. Run `scripts/ops/loop-canary.mjs` against the public sidecar and confirm
   `CANARY PASS`.

A shared gateway can serve both operator chat and Loop by having the sidecar
send `x-meridian-isolation: loop`; the dedicated-gateway form above needs no
sidecar change and is the recommended production shape.

## Server configuration

Existing deployments remain on the embedded Meridian adapter unless explicitly
changed. To select the production OpenClaw adapter (or the Hermes adapter), set:

```dotenv
ATERNA_LOOP_HARNESS=openclaw
ATERNA_LOOP_HARNESS_URL=https://internal-bridge.example/v1/loop
ATERNA_LOOP_HARNESS_TOKEN=<dedicated 32+ character bridge capability>
```

The URL and token are server-only. Never ship them in Loop or reuse the operator
gateway token. HTTPS is mandatory except for a loopback-only sidecar.

## Attested bridge contract

OpenClaw and Hermes are reached through an adjacent, private bridge. The
gateway sends this exact internal request:

```json
{
  "schemaVersion": "aterna.loop.harness.turn.request.v1",
  "requestId": "<Loop request UUID>",
  "threadId": "<Loop thread UUID>",
  "prompt": "<rendered question and authenticated excerpts>",
  "systemPolicy": "<gateway-owned Loop policy>",
  "executionPolicy": {
    "toolExecution": "disabled",
    "memoryWrite": "disabled",
    "citationScope": "request-evidence-only"
  }
}
```

The bridge must enforce those controls in the selected harness and return:

```json
{
  "schemaVersion": "aterna.loop.harness.turn.reply.v1",
  "requestId": "<same request UUID>",
  "threadId": "<same thread UUID>",
  "turnId": "<server turn identifier>",
  "text": "<answer with [segment:UUID] citations>",
  "generatedAt": "<ISO-8601 timestamp>",
  "executionPolicy": {
    "toolExecution": "disabled",
    "memoryWrite": "disabled",
    "citationScope": "request-evidence-only"
  }
}
```

The adapter rejects HTTP failures, mismatched request/thread IDs, extra or
missing fields, and absent/weaker safety attestation. The public gateway then
performs its existing citation allowlist check before returning the stable Loop
reply.

## Production handoff

1. Run the bridge beside OpenClaw and bind it to a dedicated Arlo Loop profile
   with tools and durable harness-memory writes disabled.
2. Verify the bridge contract locally with synthetic evidence only.
3. Add the three configuration values above to the Loop gateway service and
   restart it.
4. Exercise pairing and one synthetic `/v1/loop/turns` canary. Confirm the
   reply contains only supplied segment citations and still reports
   `toolExecution: disabled` and `memoryWrite: disabled`.
5. Roll back by setting `ATERNA_LOOP_HARNESS=meridian`; do not replace or delete
   the existing Loop pairing-state file.
