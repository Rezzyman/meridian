/**
 * Conversation primitives. Built on Vercel AI SDK's ModelMessage shape.
 */

import type { CoreMessage } from 'ai';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface MeridianTurn {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  channel: 'cli' | 'telegram' | 'voice' | 'gateway' | 'system' | 'slack' | 'discord';
  ts: string; // ISO
  /** CORTEX memory id assigned post-encode */
  memoryId?: number;
  /** Verification check results */
  verifications?: Array<{ name: string; passed: boolean; severity: 'block' | 'warn'; note?: string }>;
}

export interface MeridianSession {
  id: string;
  agentSlug: string;
  title?: string;
  createdAt: string;
  branchOf?: string;
  turns: MeridianTurn[];
}

export type ConversationMessages = CoreMessage[];
