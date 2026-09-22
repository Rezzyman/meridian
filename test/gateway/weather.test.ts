import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { openMeteoWeatherProvider, wmoCondition } from '../../src/gateway/weather.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

const conversation = {
  sessionId: 'weather-test',
  agentSlug: 'jira',
  historyCount: 0,
} as unknown as Conversation;

async function boot(weather?: () => Promise<unknown>): Promise<string> {
  const app = await startGateway({
    port: 0,
    token: 'device-token',
    logger: silentLogger,
    conversation,
    weather: weather as never,
  });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('gateway did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('GET /v1/weather', () => {
  it('serves gateway-owned current conditions using the Android widget contract', async () => {
    const base = await boot(async () => ({
      city: 'Denver',
      condition: 'Clear',
      temp_f: 86,
      weatherCode: 0,
      observedAt: '2026-07-29T14:00',
    }));
    const response = await fetch(`${base}/v1/weather`, {
      headers: { authorization: 'Bearer device-token' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      city: 'Denver',
      condition: 'Clear',
      temp_f: 86,
      weatherCode: 0,
      observedAt: '2026-07-29T14:00',
    });
  });

  it('fails closed when unconfigured, unauthorized, or upstream fails', async () => {
    const unconfigured = await boot();
    assert.equal(
      (await fetch(`${unconfigured}/v1/weather`, {
        headers: { authorization: 'Bearer device-token' },
      })).status,
      503,
    );
    assert.equal((await fetch(`${unconfigured}/v1/weather`)).status, 401);

    const failed = await boot(async () => {
      throw new Error('offline');
    });
    assert.equal(
      (await fetch(`${failed}/v1/weather`, {
        headers: { authorization: 'Bearer device-token' },
      })).status,
      502,
    );
  });
});

describe('Open-Meteo weather adapter', () => {
  it('requests Fahrenheit current conditions and maps WMO codes', async () => {
    let requested: URL | undefined;
    const provider = openMeteoWeatherProvider({
      city: 'Denver',
      latitude: 39.7392,
      longitude: -104.9903,
      fetchImpl: (async (input: URL | RequestInfo) => {
        requested = new URL(String(input));
        return new Response(JSON.stringify({
          current: { time: '2026-07-29T14:00', temperature_2m: 85.6, weather_code: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });

    assert.deepEqual(await provider(), {
      city: 'Denver',
      condition: 'Partly cloudy',
      temp_f: 86,
      weatherCode: 2,
      observedAt: '2026-07-29T14:00',
    });
    assert.equal(requested?.searchParams.get('temperature_unit'), 'fahrenheit');
    assert.equal(requested?.searchParams.get('current'), 'temperature_2m,weather_code');
    assert.equal(wmoCondition(95), 'Thunderstorm');
  });
});
