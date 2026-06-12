/**
 * Shared types between the wizard UI, the API routes, and the build bridge.
 * The bridge (bridge/build-agent.ts) re-declares BuildSpec structurally — it
 * runs under the meridian repo's tsx, outside this tsconfig.
 */

export type ToneKey =
  | 'warm-professional'
  | 'friendly-casual'
  | 'authoritative'
  | 'energetic'
  | 'calm-concierge';

export interface ModelPlan {
  /** canonical "provider/model" refs understood by meridian's ProviderRouter */
  primary: string;
  fallbacks: string[];
  cheapModel: string;
  /** human-readable summary for the UI, e.g. "Local Ollama (qwen2.5:3b)" */
  label: string;
  source: 'ollama' | 'env-key' | 'pasted-key' | 'none';
}

export interface SystemStatus {
  ollama: { running: boolean; models: string[] };
  keys: { anthropic: boolean; openai: boolean; groq: boolean; openrouter: boolean };
  /** The plan the builder would use right now, or null if a key is needed. */
  plan: ModelPlan | null;
}

/** What the wizard collects. The server enriches this into the bridge spec. */
export interface WizardSubmission {
  personaKey: string;
  agentName: string;
  operatorName: string;
  addressAs?: string;
  audience?: string;
  mission: string;
  tone: ToneKey;
  remember?: string;
  neverShare?: string;
  channels: { telegram: boolean; voice: boolean };
  skills: { webSearch: boolean; github: boolean; google: boolean };
  /** Optional pasted model key for machines without Ollama. */
  modelKey?: { provider: 'anthropic' | 'openai' | 'groq' | 'openrouter'; value: string };
}

export interface AgentSummary {
  slug: string;
  name: string;
  role: string;
  template?: string;
  operatorName?: string;
  port?: number;
  channels: { telegram: boolean; voice: boolean };
  skills: string[];
  gateway: GatewayStatus;
}

export type GatewayState = 'running' | 'starting' | 'stopped';

export interface GatewayStatus {
  state: GatewayState;
  port?: number;
  pid?: number;
}

export interface BuildResult {
  ok: boolean;
  slug: string;
  name: string;
  agentRoot: string;
  port: number;
  error?: string;
}
