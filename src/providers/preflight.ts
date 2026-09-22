/**
 * Provider posture preflight (defect (h), 2026-08-18).
 *
 * Arlo's gateway was configured with the routexor provider while its base URL
 * and key had been swapped to Anthropic's native endpoint. The routexor
 * adapter speaks the OpenAI-compatible protocol, so every turn was a 502 and
 * the gateway could not say why. The boot now checks the posture and refuses
 * to start on a known-bad combination, and /health reports it.
 */
const NATIVE_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.groq.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.together.xyz',
];

export interface ProviderPosture {
  ok: boolean;
  primary: string;
  provider: string;
  baseUrlHost?: string;
  reason?: string;
}

export function checkProviderPosture(
  primaryRef: string,
  env: { ROUTEXOR_BASE_URL?: string; ROUTEXOR_API_KEY?: string },
): ProviderPosture {
  const slash = primaryRef.indexOf('/');
  const provider = slash === -1 ? primaryRef : primaryRef.slice(0, slash);
  const posture: ProviderPosture = { ok: true, primary: primaryRef, provider };
  if (provider !== 'routexor') return posture;
  const base = env.ROUTEXOR_BASE_URL;
  if (!base) {
    posture.baseUrlHost = 'api.routexor.com';
    return posture;
  }
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return { ...posture, ok: false, reason: `ROUTEXOR_BASE_URL is not a valid URL: ${base}` };
  }
  posture.baseUrlHost = host;
  if (NATIVE_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return {
      ...posture,
      ok: false,
      reason:
        `model primary is routexor/* but ROUTEXOR_BASE_URL points at ${host}, a native provider endpoint. ` +
        'The routexor adapter speaks the OpenAI-compatible ROUTEXOR protocol; a native endpoint cannot answer it. ' +
        'Set ROUTEXOR_BASE_URL to https://api.routexor.com/v1 (or unset it), or change the model ref to that provider.',
    };
  }
  return posture;
}
