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
 * conversation per operator — a message from the operator over ANY of the
 * configured channels (voice, Telegram, Slack, Discord, WhatsApp, Matrix,
 * SMS, CLI) lands on the same Conversation instance and shares history.
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

/** Phone-matched channels normalize both sides to E.164-ish before comparing. */
const PHONE_CHANNELS = new Set<ChannelKind>(['voice', 'whatsapp', 'sms']);

/**
 * The operator's registered identifiers for a channel, or undefined for
 * channels that carry no per-operator identity (gateway/system are internal).
 */
function operatorChannelList(
  channels: NonNullable<AgentConfig['operator']>['channels'],
  channel: ChannelKind,
): readonly string[] | undefined {
  switch (channel) {
    case 'telegram':
      return channels.telegram;
    case 'slack':
      return channels.slack;
    case 'discord':
      return channels.discord;
    case 'matrix':
      return channels.matrix;
    case 'voice':
      return channels.voice;
    case 'whatsapp':
      return channels.whatsapp;
    case 'sms':
      return channels.sms;
    case 'cli':
      return channels.cli;
    default:
      return undefined; // gateway, system: no operator identity
  }
}

/** Does `from` match one of the operator's registered ids for this channel? */
function channelMatches(channel: ChannelKind, registered: readonly string[], from: string): boolean {
  if (channel === 'cli') return isCliMatch(registered, from);
  if (PHONE_CHANNELS.has(channel)) {
    const fromNorm = normPhone(from);
    return registered.some((num) => normPhone(num) === fromNorm);
  }
  // ID-matched channels (telegram/slack/discord/matrix): exact identifier
  // compare, no normalization — a chat id / user id / MXID is opaque.
  return registered.includes(from);
}

export function resolveOperator(
  config: AgentConfig,
  channel: ChannelKind,
  from: string,
): ResolvedOperator {
  const op = config.operator;
  if (op) {
    const registered = operatorChannelList(op.channels, channel);
    if (registered && channelMatches(channel, registered, from)) {
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
