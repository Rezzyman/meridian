/**
 * Runtime health state for /health and `meridian status` (WS5).
 *
 * The fleet health check judged the old harness by what it could not see:
 * schedules, deliveries, last-hour inference. This object is the single
 * place the gateway writes those facts so /health can read them.
 */
export interface CortexHealth {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  checkedAt: string | null;
  url?: string;
}

export class HealthState {
  readonly startedAt: string;
  private cortexState: CortexHealth = { status: 'unknown', checkedAt: null };
  private readonly turnEvents: Array<{ at: number; ok: boolean }> = [];

  constructor(
    readonly version: string,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = new Date(this.now()).toISOString();
  }

  setCortex(status: CortexHealth['status'], url?: string): void {
    this.cortexState = { status, checkedAt: new Date(this.now()).toISOString(), url };
  }

  get cortex(): CortexHealth {
    return this.cortexState;
  }

  recordTurn(ok: boolean): void {
    const at = this.now();
    this.turnEvents.push({ at, ok });
    this.prune(at);
  }

  private prune(at: number): void {
    const cutoff = at - 3600_000;
    while (this.turnEvents.length > 0 && (this.turnEvents[0]?.at ?? 0) < cutoff)
      this.turnEvents.shift();
  }

  lastHourInference(): { turns: number; errors: number } {
    this.prune(this.now());
    let errors = 0;
    for (const e of this.turnEvents) if (!e.ok) errors += 1;
    return { turns: this.turnEvents.length, errors };
  }

  uptimeSec(): number {
    return Math.floor((this.now() - Date.parse(this.startedAt)) / 1000);
  }
}
