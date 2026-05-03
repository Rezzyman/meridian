/**
 * Voice built-ins. Outbound calls and assistant management. The underlying
 * provider is white-labeled; tool names exposed to the model are neutral.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { AgentEnv } from '../../config/schema.js';

const VAPI_BASE = 'https://api.vapi.ai';

async function vapi(
  env: AgentEnv,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!env.VAPI_API_KEY) {
    return { ok: false, status: 0, body: { error: 'VAPI_API_KEY not set' } };
  }
  const res = await fetch(`${VAPI_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // pass-through text
  }
  return { ok: res.ok, status: res.status, body };
}

export function voiceTools(env: AgentEnv) {
  return {
    voice_call: tool({
      description:
        'Place an outbound voice call. Returns when the call is queued, not when it completes.',
      parameters: z.object({
        phoneNumber: z.string().describe('E.164 phone number to call'),
        assistantOverrides: z.record(z.unknown()).optional(),
      }),
      execute: async ({ phoneNumber, assistantOverrides }) => {
        if (!env.VAPI_PHONE_NUMBER_ID || !env.VAPI_ASSISTANT_ID) {
          return { ok: false, error: 'voice channel not provisioned' };
        }
        return vapi(env, '/call', {
          method: 'POST',
          body: JSON.stringify({
            phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
            assistantId: env.VAPI_ASSISTANT_ID,
            assistantOverrides,
            customer: { number: phoneNumber },
          }),
        });
      },
    }),
    voice_status: tool({
      description: 'Fetch the current voice assistant configuration.',
      parameters: z.object({}),
      execute: async () => {
        if (!env.VAPI_ASSISTANT_ID) return { ok: false, error: 'voice assistant not configured' };
        return vapi(env, `/assistant/${env.VAPI_ASSISTANT_ID}`);
      },
    }),
  };
}
