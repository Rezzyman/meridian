import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
  timezoneConfigured,
} from '../../src/config/timezone.js';

describe('timezone resolution (defect b: silent America/Chicago default)', () => {
  it('first valid IANA zone wins', () => {
    assert.equal(
      resolveTimezone(undefined, 'Not/AZone', 'America/Denver', 'UTC'),
      'America/Denver',
    );
  });
  it('falls back to UTC, never to a city nobody configured', () => {
    assert.equal(resolveTimezone(undefined, null, ''), DEFAULT_TIMEZONE);
    assert.notEqual(resolveTimezone(), 'America/Chicago');
  });
  it('validates zones', () => {
    assert.equal(isValidTimezone('America/Denver'), true);
    assert.equal(isValidTimezone('Mars/Olympus'), false);
    assert.equal(isValidTimezone(undefined), false);
  });
  it('reports whether anything real was configured', () => {
    assert.equal(timezoneConfigured(undefined, ''), false);
    assert.equal(timezoneConfigured(undefined, 'Europe/Lisbon'), true);
  });
});
