/**
 * Slash-command registry. Single source of truth for the REPL, gateway
 * dispatch, future Telegram bot commands, and tab completion.
 *
 * Trimmed to ~15 commands per the strategy doc (the harness is internal
 * dev surface, not the product moat). CORTEX-native commands are the
 * unique additions.
 */

export interface CommandDef {
  name: string;
  description: string;
  category: 'Session' | 'Info' | 'Configuration' | 'Tools' | 'CORTEX' | 'Exit';
  aliases?: readonly string[];
  argsHint?: string;
}

export const COMMAND_REGISTRY: readonly CommandDef[] = [
  // Session
  { name: 'new', description: 'Start a new session (fresh id, fresh history)', category: 'Session', aliases: ['reset'] },
  { name: 'clear', description: 'Clear screen and start a new session', category: 'Session' },
  { name: 'history', description: 'Show conversation history', category: 'Session' },
  { name: 'save', description: 'Save the current conversation', category: 'Session' },
  { name: 'retry', description: 'Resend the last user message', category: 'Session' },

  // Info
  { name: 'help', description: 'Show available commands', category: 'Info' },
  { name: 'profile', description: 'Show active agent home and config', category: 'Info' },
  { name: 'usage', description: 'Show token usage for the current session', category: 'Info' },

  // Configuration
  { name: 'model', description: 'Switch model for this session', category: 'Configuration', argsHint: '[model]' },
  { name: 'provider', description: 'Show available providers', category: 'Configuration' },
  { name: 'auth', description: 'Authorize a passphrase-guarded skill for this session', category: 'Configuration', argsHint: '<skill> <passphrase>' },

  // Tools
  { name: 'tools', description: 'List enabled tools', category: 'Tools' },
  { name: 'skills', description: 'List loaded skills', category: 'Tools' },
  { name: 'automations', description: 'List automations and last/next runs', category: 'Tools', aliases: ['cron'] },

  // CORTEX (Meridian-native)
  { name: 'cortex', description: 'Show CORTEX status, dream state, last encode', category: 'CORTEX' },
  { name: 'recall', description: 'Force a CORTEX CA3 recall and print top-K', category: 'CORTEX', argsHint: '<query>' },
  { name: 'memory', description: 'Structured memory digest grouped by source', category: 'CORTEX', argsHint: '<topic>' },
  { name: 'commitments', description: 'Show open commitments from the ledger', category: 'CORTEX' },
  { name: 'decisions', description: 'Show logged decisions from the ledger', category: 'CORTEX' },
  { name: 'why', description: 'Show the memories that backed an agent claim', category: 'CORTEX', argsHint: '<claim>' },
  { name: 'trace', description: 'Show the full reasoning chain for a turn', category: 'CORTEX', argsHint: '<turn-id|last>' },
  { name: 'encode', description: 'Manually encode a memory with a label', category: 'CORTEX', argsHint: '<text>' },
  { name: 'dream', description: 'Trigger a dream cycle on demand', category: 'CORTEX' },
  { name: 'audit', description: 'Run a verification retrospective and write the report', category: 'CORTEX' },

  // Exit
  { name: 'quit', description: 'Exit the CLI', category: 'Exit', aliases: ['exit', 'q'] },
];

export const COMMAND_NAMES: ReadonlySet<string> = new Set(
  COMMAND_REGISTRY.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
);

export function findCommand(name: string): CommandDef | undefined {
  const stripped = name.startsWith('/') ? name.slice(1) : name;
  for (const c of COMMAND_REGISTRY) {
    if (c.name === stripped) return c;
    if (c.aliases?.includes(stripped)) return c;
  }
  return undefined;
}

export function commandsByCategory(): Record<string, CommandDef[]> {
  const out: Record<string, CommandDef[]> = {};
  for (const c of COMMAND_REGISTRY) {
    if (!out[c.category]) out[c.category] = [];
    out[c.category].push(c);
  }
  return out;
}
