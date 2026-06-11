/**
 * Interactive agent picker. Fires when `meridian chat` is invoked without
 * an explicit --agent flag or MERIDIAN_AGENT env var. Lists every agent
 * found under ~/.meridian/<slug>/ and prompts the user to choose.
 *
 * Always asks (per Atanasio's preference) so the agent identity is
 * explicit on every launch, even on a single-agent home.
 */

import readline from 'node:readline';
import { describeAgents } from '../config/home.js';
import { colors } from '../utils/truecolor.js';

export async function pickAgentInteractive(envOverride?: string): Promise<string> {
  // Explicit override wins — used by /usr/local/bin/<agent> shortcuts and CI.
  if (envOverride?.trim()) return envOverride.trim();

  const agents = describeAgents();
  if (agents.length === 0) {
    console.log(colors.err('No agents found in ~/.meridian/.'));
    console.log(colors.muted('Run `meridian init <slug>` to create one.'));
    process.exit(1);
  }

  // Render list
  console.log('');
  console.log(colors.cyan('Which agent would you like to interface with?'));
  console.log('');
  agents.forEach((a, i) => {
    const num = colors.muted(`${(i + 1).toString().padStart(2)})`);
    const name = colors.bold + a.name + colors.reset;
    const slug = colors.muted(`(${a.slug})`);
    const role = a.role ? colors.muted(`  ·  ${a.role.replace(/_/g, ' ')}`) : '';
    console.log(`  ${num}  ${name} ${slug}${role}`);
  });
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (a) => res(a)));

  while (true) {
    const ans = (await ask(`${colors.cyan('❯')} pick [1-${agents.length}] or slug: `)).trim();
    // Empty → repeat (no silent default — explicit per Atanasio's UX rule)
    if (!ans) continue;
    // Number?
    if (/^\d+$/.test(ans)) {
      const idx = parseInt(ans, 10) - 1;
      if (idx >= 0 && idx < agents.length) {
        rl.close();
        return agents[idx]!.slug;
      }
      console.log(colors.warn(`  out of range`));
      continue;
    }
    // Slug match?
    const hit = agents.find((a) => a.slug === ans);
    if (hit) {
      rl.close();
      return hit.slug;
    }
    console.log(colors.warn(`  no agent named "${ans}"`));
  }
}
