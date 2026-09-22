import { join } from 'node:path';
import { activeAgentSlug, ensureAgentHome } from '../config/home.js';
import { loadAgentEnv } from '../config/loader.js';
import { LoopPairingStore } from '../gateway/loop-pairing.js';
import { colors } from '../utils/truecolor.js';

export function runLoopPair(ttlMinutes: number): void {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const env = loadAgentEnv(home);
  const statePath = env.MERIDIAN_LOOP_STATE_PATH ?? join(home.agentRoot, 'loop-pairings.json');
  const issued = new LoopPairingStore(statePath)
    .issuePairingCode(ttlMinutes * 60_000);
  console.log(colors.ok(`Pair Loop with ${slug}:`));
  console.log(`\n  ${issued.code}\n`);
  console.log(colors.muted(`One use · expires ${issued.expiresAt}`));
}
