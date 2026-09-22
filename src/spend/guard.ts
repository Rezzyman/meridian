import type { SpendLedger } from './ledger.js';

/**
 * Spend caps (WS4). Checked BEFORE a provider call; settled AFTER with the
 * real usage. `undefined` caps mean no cap. `onExceed` decides what happens:
 *   block    the turn is refused with a plain-language message
 *   degrade  the turn proceeds on the cheap model only (caller decides which)
 */
export interface SpendPolicy {
  perTurnUsd?: number;
  perRunUsd?: number;
  dailyUsd?: number;
  monthlyUsd?: number;
  onExceed: 'block' | 'degrade';
}

export interface SpendVerdict {
  ok: boolean;
  action: 'allow' | 'block' | 'degrade';
  reason?: string;
  todayUsd: number;
  monthUsd: number;
}

export function checkSpend(
  ledger: SpendLedger,
  policy: SpendPolicy | undefined,
  opts: { jobId?: string } = {},
): SpendVerdict {
  const today = ledger.today();
  const month = ledger.month();
  const base = { todayUsd: today.usd, monthUsd: month.usd };
  if (!policy) return { ok: true, action: 'allow', ...base };
  const exceeded = (label: string, spent: number, cap: number): SpendVerdict => ({
    ok: policy.onExceed === 'degrade',
    action: policy.onExceed,
    reason: `${label} spend cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}`,
    ...base,
  });
  if (policy.dailyUsd !== undefined && today.usd >= policy.dailyUsd)
    return exceeded('daily', today.usd, policy.dailyUsd);
  if (policy.monthlyUsd !== undefined && month.usd >= policy.monthlyUsd)
    return exceeded('monthly', month.usd, policy.monthlyUsd);
  if (opts.jobId && policy.perRunUsd !== undefined) {
    const run = ledger.job(opts.jobId).usd;
    if (run >= policy.perRunUsd) return exceeded('per-run', run, policy.perRunUsd);
  }
  return { ok: true, action: 'allow', ...base };
}

/** Plain-language refusal for a trusted operator channel. */
export function spendRefusal(verdict: SpendVerdict): string {
  return `I have hit a spend cap and stopped before calling the model (${verdict.reason}). Raise the cap in config.yaml under spend, or wait for the window to roll over.`;
}
