/**
 * Channel adapter contract. Every channel (CLI, Telegram, VAPI, Gateway)
 * implements this so the dispatcher is uniform.
 */

import type { Conversation } from '../agent/conversation.js';

export interface InboundMessage {
  channel: 'cli' | 'telegram' | 'voice' | 'gateway' | 'system' | 'slack' | 'discord' | 'whatsapp' | 'matrix';
  from: string; // user id, phone, chat id, etc.
  text: string;
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: InboundMessage['channel'];
  to: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly name: string;
  start(conversation: Conversation, opts: ChannelStartOptions): Promise<void> | void;
  stop(): Promise<void> | void;
  send?(msg: OutboundMessage): Promise<void> | void;
}

export interface ChannelStartOptions {
  onInbound: (msg: InboundMessage) => Promise<string>;
}
