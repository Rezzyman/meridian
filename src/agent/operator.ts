/**
 * Operator identity resolution.
 *
 * Meridian's "real partner" claim depends on continuity across channels —
 * the same operator talking through voice, Telegram, and REPL should hold
 * one continuous conversation, not three parallel disjoint threads.
 *
 * Each agent has exactly one operator (the human it answers to). The
 * operator is identified canonically by `operator.id` in config.yaml.
 * `resolveOperator(config, channel, from)` maps a channel-specific
 * identifier (chat id, phone number, OS username) to the canonical
 * operator id, falling back to `unknown:<channel>:<from>` when no
 * match is found.
 *
 * Session keys derived from operator id mean the gateway looks up ONE
 * conversation per operator — voice + telegram + cli land on the same
 * Conversation instance and share history.
 */

import type { AgentConfig } from '../config/schema.js';
import type { MeridianTurn } from './types.js';

export type ChannelKind = MeridianTurn['channel'];

export interface ResolvedOperator {
  id: string; // canonical operator id used as session key
  source: 'config' | 'unknown';
  channel: ChannelKind;
  from: string; // raw channel-specific identifier
}

/**
 * Normalise phone numbers to E.164-ish for cross-channel comparison.
 * Strips spaces, parens, dashes, and a literal "+" so "+1 (303) 997-1189"
 * matches "13039971189" matches "+13039971189".
 */
function normPhone(s: string): string {
  return s.replace(/[\s()\-+]/g, '');
}

/** OS username, plus a couple of common aliases (root often = the operator on a single-user VPS). */
function isCliMatch(operatorCli: readonly string[], from: string): boolean {
  const fromLower = from.toLowerCase();
  for (const u of operatorCli) {
    if (u.toLowerCase() === fromLower) return true;
  }
  return false;
}

export function resolveOperator(
  config: AgentConfig,
  channel: ChannelKind,
  from: string,
): ResolvedOperator {
  const op = config.operator;
  if (op) {
    if (channel === 'telegram' && op.channels.telegram.includes(from)) {
      return { id: op.id, source: 'config', channel, from };
    }
    if (channel === 'voice') {
      const fromNorm = normPhone(from);
      for (const num of op.channels.voice) {
        if (normPhone(num) === fromNorm) {
          return { id: op.id, source: 'config', channel, from };
        }
      }
    }
    if (channel === 'cli' && isCliMatch(op.channels.cli, from)) {
      return { id: op.id, source: 'config', channel, from };
    }
  }
  // Unrecognised caller — keyed by channel+from so anonymous threads still
  // get their own continuity, but they are NOT mixed with the operator.
  return {
    id: `unknown:${channel}:${from || 'anon'}`,
    source: 'unknown',
    channel,
    from,
  };
}

/**
 * Convenience: derive a stable session-store id for an operator. We prefix
 * with `op:` so it never collides with a UUID-shaped session id.
 */
export function operatorSessionId(operatorId: string): string {
  return `op:${operatorId}`;
}
