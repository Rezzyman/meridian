# Meridian test suite

`pnpm test` → `node --test --import tsx 'test/**/*.test.ts'` (Node ≥22 expands the
glob natively; quoted so the shell never has to).

## Conventions

- **node:test + node:assert/strict.** No vitest/jest, no module mocking — every
  seam is dependency-injected through real entry points (`TurnContext`,
  `fetchImpl`, constructor opts).
- **Shared fixtures live in `test/helpers/fixtures.ts`**: `makeConfig`,
  `makeEnv`, `silentLogger`, `mockCortex` (records `recallCalls`/`encodeCalls`),
  `textModel`/`failingModel` (AI SDK `MockLanguageModelV1`), `mockRouter`,
  `settle`. Build your world from these so the suite has one idiom.
- **encode is fire-and-forget** in `runTurn`: never assert on
  `TurnResult.encodeOk` (hardcoded `false`) or `turn.memoryId` (always
  `undefined`). Assert through `mockCortex().encodeCalls` after `await settle()`.
- **No network, no `~/.meridian`.** Redirect `HOME`/`MERIDIAN_HOME` to a tmpdir
  *before* importing modules that capture them at import time
  (`MERIDIAN_CORTEX_URL` is captured at module load — always pass explicit
  `baseUrl` instead).
- Fixture keys are syntactically valid dummies; never put a live key in a test.
- Keep files independently runnable: `node --test --import tsx test/agent/turn.test.ts`.

## Layout

```
test/
  helpers/fixtures.ts      shared DI stubs + config/env factories
  agent/                   turn loop, conversation, operator resolution
  memory/                  CortexBind HTTP contract, provider factory seam
  skills/                  loader + dynamic tool registration
  secrets/                 vault encrypt/decrypt
  providers/               router resolution, chains, smart routing
  verification/            check loading + helpers (contract tests; unwired in runtime today)
  mcp/                     MCP client/server interop
  gateway/                 HTTP + SSE streaming endpoints
```
