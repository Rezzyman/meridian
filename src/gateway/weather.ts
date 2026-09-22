/** Current conditions exposed to the child device through its own Meridian gateway. */
export interface DeviceWeather {
  city: string;
  condition: string;
  /** Android wire contract intentionally uses snake_case. */
  temp_f: number;
  weatherCode: number;
  observedAt: string;
}

export type WeatherProvider = () => Promise<DeviceWeather>;

interface OpenMeteoCurrent {
  time?: string;
  temperature_2m?: number;
  weather_code?: number;
}

interface OpenMeteoResponse {
  current?: OpenMeteoCurrent;
}

/**
 * Gateway-owned Open-Meteo adapter. The R1 never receives a third-party credential and never
 * talks to a weather host directly, preserving the CHILD profile's single-destination egress.
 */
export function openMeteoWeatherProvider(opts: {
  city: string;
  latitude: number;
  longitude: number;
  fetchImpl?: typeof fetch;
}): WeatherProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async () => {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(opts.latitude));
    url.searchParams.set('longitude', String(opts.longitude));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');

    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'Meridian-R1/1.0 (weather gateway)' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`weather provider returned ${response.status}`);
    const body = (await response.json()) as OpenMeteoResponse;
    const current = body.current;
    if (
      !current ||
      typeof current.temperature_2m !== 'number' ||
      typeof current.weather_code !== 'number'
    ) {
      throw new Error('weather provider response missing current conditions');
    }
    return {
      city: opts.city,
      condition: wmoCondition(current.weather_code),
      temp_f: Math.round(current.temperature_2m),
      weatherCode: current.weather_code,
      observedAt: current.time ?? new Date().toISOString(),
    };
  };
}

export function wmoCondition(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Foggy';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code >= 85 && code <= 86) return 'Snow showers';
  if (code >= 95 && code <= 99) return 'Thunderstorm';
  return 'Current weather';
}
