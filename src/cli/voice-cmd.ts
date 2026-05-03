/**
 * `meridian voice` — manage voice-channel configuration.
 *
 * Subcommands:
 *   meridian voice passphrase           — set or rotate the unlock phrase
 *   meridian voice passphrase --clear   — remove the phrase (locks all voice tools)
 *   meridian voice status               — show whether a phrase is set, no plaintext
 *
 * The passphrase is stored normalised (lowercase, alphanumeric+space only)
 * inside the agent's encrypted vault. The transcript scanner in VapiChannel
 * matches against this normalised form so STT casing/punctuation drift
 * doesn't break recognition.
 */

import readline from 'node:readline/promises';
import { activeAgentSlug, ensureAgentHome } from '../config/home.js';
import { openAgentVault } from '../secrets/vault.js';
import { VoiceSessionGuard, normalisePhrase } from '../voice/session-guard.js';
import { createLogger } from '../logger/pino.js';
import { colors } from '../utils/truecolor.js';

export async function runVoicePassphrase(opts: { clear?: boolean }): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const logger = createLogger({ home });
  const vault = openAgentVault({ envPath: home.envPath, vaultPath: home.vaultPath });
  const guard = new VoiceSessionGuard(vault, logger);

  if (opts.clear) {
    guard.clearPassphrase();
    console.log(colors.ok('voice passphrase cleared. Privileged voice tools are now unreachable on this agent.'));
    return;
  }

  console.log(colors.cyan(`Set voice passphrase for agent ${slug}.`));
  console.log(
    colors.muted(
      '  This phrase unlocks privileged voice tools (telegram_dm, cortex_recall,\n' +
        '  cortex_encode) for 30 min when spoken on a call. Stored encrypted in vault.\n' +
        '  Pick something distinctive enough not to be uttered by accident,\n' +
        '  but easy to say on a phone (no special characters needed).',
    ),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const phrase1 = (await rl.question('  passphrase: ')).trim();
    const norm = normalisePhrase(phrase1);
    if (norm.length < 4) {
      console.log(colors.err('  too short after normalisation (need ≥4 chars of letters/digits)'));
      process.exit(1);
    }
    const phrase2 = (await rl.question('  confirm:    ')).trim();
    if (normalisePhrase(phrase2) !== norm) {
      console.log(colors.err('  phrases did not match'));
      process.exit(1);
    }
    guard.setPassphrase(phrase1);
    console.log(colors.ok(`  voice passphrase set (normalised: "${norm}")`));
    console.log(
      colors.muted(
        '  Restart the gateway for the new phrase to take effect on live calls.',
      ),
    );
  } finally {
    rl.close();
  }
}

export function runVoiceStatus(): void {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const logger = createLogger({ home });
  const vault = openAgentVault({ envPath: home.envPath, vaultPath: home.vaultPath });
  const guard = new VoiceSessionGuard(vault, logger);
  console.log(colors.cyan(`Voice · agent ${slug}`));
  console.log(`  passphrase set: ${guard.isConfigured() ? colors.ok('yes') : colors.warn('no')}`);
  if (!guard.isConfigured()) {
    console.log(colors.muted('  privileged voice tools (telegram_dm, cortex_*) are unreachable until set'));
    console.log(colors.muted('  run `meridian voice passphrase` to configure'));
  }
}

/**
 * `meridian voice call <e164-number>` — place an outbound call.
 *
 * Calls the active agent's running gateway over HTTP /vapi/call. Requires
 * the gateway to be running and the agent's .env to have VAPI_API_KEY,
 * VAPI_PHONE_NUMBER_ID, VAPI_ASSISTANT_ID, MERIDIAN_GATEWAY_TOKEN, and
 * MERIDIAN_GATEWAY_PORT set.
 *
 * Use cases: smoke-test the outbound flow, manually trigger a follow-up
 * call to a stakeholder, or kick off the onboarding-call moment for a
 * new operator from the CLI.
 */
export async function runVoiceCall(opts: {
  to: string;
  firstMessage?: string;
  customerName?: string;
}): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const { loadAgentEnv } = await import('../config/loader.js');
  const env = loadAgentEnv(home);

  if (!env.VAPI_API_KEY) {
    console.log(colors.err('VAPI_API_KEY not set in this agent\'s .env'));
    process.exit(1);
  }
  if (!env.MERIDIAN_GATEWAY_TOKEN) {
    console.log(colors.err('MERIDIAN_GATEWAY_TOKEN not set; gateway HTTP endpoints would be unauthorized'));
    process.exit(1);
  }
  const port = env.MERIDIAN_GATEWAY_PORT ?? 18889;
  const url = `http://127.0.0.1:${port}/vapi/call`;
  console.log(colors.muted(`POST ${url} → outbound call to ${opts.to}`));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MERIDIAN_GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: opts.to,
        firstMessage: opts.firstMessage,
        customerName: opts.customerName,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.log(colors.err(`gateway returned ${res.status}: ${body}`));
      process.exit(1);
    }
    console.log(colors.ok(`call queued: ${body}`));
  } catch (err) {
    console.log(colors.err(`failed to reach gateway at ${url}: ${(err as Error).message}`));
    console.log(colors.muted('is the gateway running? (`meridian gateway`)'));
    process.exit(1);
  }
}
