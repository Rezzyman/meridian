/**
 * Preview the full Meridian boot experience as a user sees it on day one.
 *
 *   pnpm tsx scripts/preview-boot.ts > /tmp/meridian-boot.ansi
 *
 * Then `cat /tmp/meridian-boot.ansi` in a real terminal for the cyan colors.
 */

import { renderLogo, renderBootPanel, renderStatusBar, welcomeLine } from '../src/cli/banner.js';
import { BUNDLED_SKILL_LIBRARY } from '../src/cli/skill-library.js';

const screen = [
  '',
  renderLogo(),
  '',
  renderBootPanel({
    version: '0.1.0',
    releaseDate: '2026.4.27',
    agentSlug: 'frontdesk',
    agentName: 'Front Desk',
    toolsByCategory: {
      core: ['bash', 'read', 'write', 'edit', 'web_fetch'],
      cognition: ['cortex_recall', 'cortex_encode', 'cortex_dream'],
      voice: ['voice_call', 'voice_status'],
    },
    mcpServers: [{ name: 'cortex', transport: 'native', toolCount: 0 }],
    essentialSkills: [
      { name: 'voice-receptionist', enabled: true },
      { name: 'outbound-caller', enabled: true },
      { name: 'cross-channel-recall', enabled: true },
      { name: 'inbox-triage', enabled: true },
      { name: 'calendar-prep', enabled: true },
      { name: 'commitment-ledger', enabled: true },
      { name: 'voice-of-user', enabled: true },
      { name: 'handoff', enabled: true },
      { name: 'decision-memo', enabled: true },
      { name: 'daily-summary', enabled: true },
    ],
    skillLibrary: BUNDLED_SKILL_LIBRARY,
    layerStatus: {
      identity: true,
      context: false,
      skills: true,
      memory: true,
      connections: false,
      verification: true,
      automations: true,
    },
    cortex: {
      status: 'ok',
      database: 'connected',
    },
    cwd: '/Users/rezcorp',
    sessionId: 's_a1b3c4',
  }),
  '',
  welcomeLine('Front Desk'),
  '',
  renderStatusBar({
    ctxPct: 0,
    dreamState: 'idle',
    agent: 'frontdesk',
    elapsedSec: 0,
  }),
  '─'.repeat(118),
  '❯ ',
  '─'.repeat(118),
  '',
];

console.log(screen.join('\n'));
