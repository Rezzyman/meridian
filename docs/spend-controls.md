# Spend controls

Every model call Meridian makes is written to the agent's ledger, and caps are checked before the call is made. This is the harness-level brake. It works with no router support, and it works alongside ROUTEXOR's own per-key limits.

## What is recorded

`<agent home>/LEDGER/spend-YYYY-MM-DD.jsonl`, one JSON line per call:

- `ts`, `agentId`, `scope` (`turn` or `automation`), `sessionId`, `channel`, `jobId`, `model`
- `promptTokens`, `completionTokens`
- `usd`, or `null` when the model is not in the pricing catalog. Unpriced tokens are reported separately and never hidden.

Prices come from the ROUTEXOR catalog (`/v1/models`, USD per million tokens) fetched once at gateway boot. If the fetch fails the gateway still runs and records tokens without dollars.

## Caps

In `config.yaml`:

```yaml
spend:
  perTurnUsd: 0.25      # warns in the log when one turn exceeds this
  perRunUsd: 1.00       # an automation run stops before the call once its job has spent this today
  dailyUsd: 10.00       # the agent stops calling models for the rest of the UTC day
  monthlyUsd: 150.00    # same, for the calendar month
  onExceed: block       # or degrade: keep answering on the cheap model only
```

All caps are optional. With no caps set, `meridian doctor` warns.

When a daily or monthly cap is reached:

- a chat turn on a trusted channel answers in plain language that the cap was hit and how to raise it, and makes no provider call
- a scheduled automation is skipped with reason `spend cap` and the operator is told once
- with `onExceed: degrade` the turn proceeds on `models.smartRouting.cheapModel` only

## Where to see it

- `GET /health` returns `spend.today` and `spend.month`
- `meridian doctor` prints a Spend row with today's total and the caps in force
- `/trace` and `/why` show the tokens and USD for a turn

## Runaway brake inside a turn

The same tool called with identical arguments more than four times in one turn is quarantined for the rest of that turn, and the model is told to answer with what it has. Combined with `governance.maxToolCallsPerTurn` and the empty-result breaker, a looping turn cannot spend unbounded money.

## Restart ceiling

`skeleton/systemd/meridian-gateway@.service` carries `StartLimitIntervalSec=300` and `StartLimitBurst=5`, so a crashing gateway restarts at most five times in five minutes and then stays stopped until an operator looks.
