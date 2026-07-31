import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextCronOccurrence, scheduleDeterministic } from '../../src/autonomy/scheduler.js';

describe('deterministic cron calculation', () => {
  it('calculates the next weekday instead of jumping to the next matching January', () => {
    const from = new Date('2026-07-31T23:30:02.000Z'); // Friday 17:30 MDT
    assert.equal(nextCronOccurrence('0 8 * * 1-5', from, 'America/Denver').toISOString(), '2026-08-03T14:00:00.000Z');
    assert.equal(nextCronOccurrence('30 17 * * 1-5', from, 'America/Denver').toISOString(), '2026-08-03T23:30:00.000Z');
  });

  it('honors timezone offsets across both DST transitions', () => {
    assert.equal(
      nextCronOccurrence('0 8 * * *', new Date('2026-03-07T15:01:00Z'), 'America/Denver').toISOString(),
      '2026-03-08T14:00:00.000Z',
    );
    assert.equal(
      nextCronOccurrence('0 8 * * *', new Date('2026-10-31T14:01:00Z'), 'America/Denver').toISOString(),
      '2026-11-01T15:00:00.000Z',
    );
  });

  it('supports lists, ranges, steps, and six-field second schedules', () => {
    const friday = new Date('2026-07-31T13:59:58Z');
    assert.equal(nextCronOccurrence('0 8 * * 1,2,3,4,5', friday, 'America/Denver').toISOString(), '2026-07-31T14:00:00.000Z');
    assert.equal(nextCronOccurrence('*/5 * * * * *', friday, 'UTC').toISOString(), '2026-07-31T14:00:00.000Z');
  });

  it('rejects malformed or impossible field values', () => {
    assert.throws(() => nextCronOccurrence('0 25 * * *', new Date(), 'UTC'), /invalid cron field/);
    assert.throws(() => nextCronOccurrence('not cron', new Date(), 'UTC'), /5 or 6 fields/);
  });
});

describe('deterministic timer', () => {
  it('fires with the exact scheduled occurrence and advances its boundary', async () => {
    let task: ReturnType<typeof scheduleDeterministic>;
    let watchdog: NodeJS.Timeout;
    const scheduledAt = await new Promise<Date>((resolve, reject) => {
      task = scheduleDeterministic('*/1 * * * * *', (at) => { clearTimeout(watchdog); resolve(at); }, { timezone: 'UTC' });
      watchdog = setTimeout(() => reject(new Error('deterministic timer did not fire')), 2_500);
    });
    assert.equal(scheduledAt.getMilliseconds(), 0);
    assert.ok(task!.getNextRun());
    task!.stop();
  });
});
