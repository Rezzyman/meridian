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
