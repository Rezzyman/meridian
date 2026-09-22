import type { Conversation } from '../agent/conversation.js';

/**
 * Harness-neutral server boundary for Aterna Loop.
 *
 * The iOS client only speaks the public `aterna.loop.*.v1` contract. Harness
 * identity is deliberately kept on this side of the gateway so OpenClaw,
 * Hermes, and Meridian can be swapped without an app release or a new device
 * token.
 */
export const LOOP_HARNESS_KINDS = ['openclaw', 'hermes', 'meridian'] as const;
export type LoopHarnessKind = (typeof LOOP_HARNESS_KINDS)[number];

export const LOOP_AGENT_CAPABILITIES = {
  toolExecution: 'disabled',
  memoryWrite: 'disabled',
  citationScope: 'request-evidence-only',
} as const;

export interface LoopAgentIdentity {
  slug: string;
  displayName: string;
}

export interface LoopAgentTurnInput {
  requestId: string;
  threadId: string;
  prompt: string;
  systemPolicy: string;
}

export interface LoopAgentTurnResult {
  turnId: string;
  text: string;
  generatedAt: string;
}

/** The only capability the public Loop route needs from an agent runtime. */
export interface LoopAgentAdapter {
  /** Server-side routing metadata. This value must never enter a Loop reply. */
  readonly harness: LoopHarnessKind;
  readonly identity: LoopAgentIdentity;
  readonly capabilities: typeof LOOP_AGENT_CAPABILITIES;
  sendTurn(input: LoopAgentTurnInput): Promise<LoopAgentTurnResult>;
}

export type LoopAgentAdapterRegistry = Partial<Record<LoopHarnessKind, LoopAgentAdapter>>;

export function selectLoopAgentAdapter(
  configuredHarness: LoopHarnessKind,
  adapters: LoopAgentAdapterRegistry,
): LoopAgentAdapter {
  const selected = adapters[configuredHarness];
  if (!selected) {
    throw new Error(
      `Loop harness '${configuredHarness}' is selected but its adapter is not configured`,
    );
  }
  if (selected.harness !== configuredHarness) {
    throw new Error(
      `Loop adapter registry mismatch: '${configuredHarness}' points to '${selected.harness}'`,
    );
  }
  return selected;
}

function defaultDisplayName(slug: string): string {
  return slug.length === 0 ? slug : slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Compatibility adapter for Meridian's in-process Conversation runtime. */
export function createMeridianLoopAgentAdapter(
  conversation: Conversation,
  displayName = defaultDisplayName(conversation.agentSlug),
): LoopAgentAdapter {
  return {
    harness: 'meridian',
    identity: { slug: conversation.agentSlug, displayName },
    capabilities: LOOP_AGENT_CAPABILITIES,
    async sendTurn(input) {
      const turn = await conversation.send(input.prompt, {
        isolation: {
          disableTools: true,
          disableMemoryWrite: true,
          systemPolicy: input.systemPolicy,
        },
      });
      return { turnId: turn.id, text: turn.content, generatedAt: turn.ts };
    },
  };
}

export const LOOP_HARNESS_TURN_REQUEST_SCHEMA = 'aterna.loop.harness.turn.request.v1' as const;
export const LOOP_HARNESS_TURN_REPLY_SCHEMA = 'aterna.loop.harness.turn.reply.v1' as const;

interface HarnessBridgeReply {
  schemaVersion: typeof LOOP_HARNESS_TURN_REPLY_SCHEMA;
  requestId: string;
  threadId: string;
  turnId: string;
  text: string;
  generatedAt: string;
  executionPolicy: typeof LOOP_AGENT_CAPABILITIES;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export interface AttestedHarnessAdapterOptions {
  harness: Exclude<LoopHarnessKind, 'meridian'>;
  identity: LoopAgentIdentity;
  /** Exact server-side bridge URL. It is never returned to the iOS client. */
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validBridgeUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Loop harness bridge must use HTTPS (or loopback HTTP) without URL credentials',
    );
  }
  return url;
}

function parseBridgeReply(value: unknown, input: LoopAgentTurnInput): HarnessBridgeReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (
    !exactKeys(reply, [
      'schemaVersion',
      'requestId',
      'threadId',
      'turnId',
      'text',
      'generatedAt',
      'executionPolicy',
    ])
  )
    return null;
  const policy = reply.executionPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const policyRecord = policy as Record<string, unknown>;
  if (!exactKeys(policyRecord, ['toolExecution', 'memoryWrite', 'citationScope'])) return null;
  if (
    reply.schemaVersion !== LOOP_HARNESS_TURN_REPLY_SCHEMA ||
    reply.requestId !== input.requestId ||
    reply.threadId !== input.threadId ||
    typeof reply.turnId !== 'string' ||
    reply.turnId.length === 0 ||
    reply.turnId.length > 256 ||
    typeof reply.text !== 'string' ||
    reply.text.length === 0 ||
    Buffer.byteLength(reply.text, 'utf8') > 256 * 1024 ||
    typeof reply.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(reply.generatedAt)) ||
    policyRecord.toolExecution !== LOOP_AGENT_CAPABILITIES.toolExecution ||
    policyRecord.memoryWrite !== LOOP_AGENT_CAPABILITIES.memoryWrite ||
    policyRecord.citationScope !== LOOP_AGENT_CAPABILITIES.citationScope
  )
    return null;
  return value as HarnessBridgeReply;
}

/**
 * Adapter for an adjacent OpenClaw or Hermes bridge. The bridge must attest
 * the same no-tools/no-write capability on every response; missing or weaker
 * attestation fails closed before anything reaches the phone.
 */
export function createAttestedHarnessLoopAgentAdapter(
  opts: AttestedHarnessAdapterOptions,
): LoopAgentAdapter {
  const url = validBridgeUrl(opts.url);
  if (opts.token.length < 32)
    throw new Error('Loop harness bridge token must be at least 32 characters');
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('Loop harness bridge timeout must be between 1 and 120 seconds');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    harness: opts.harness,
    identity: opts.identity,
    capabilities: LOOP_AGENT_CAPABILITIES,
    async sendTurn(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.token}`,
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
          body: JSON.stringify({
            schemaVersion: LOOP_HARNESS_TURN_REQUEST_SCHEMA,
            requestId: input.requestId,
            threadId: input.threadId,
            prompt: input.prompt,
            systemPolicy: input.systemPolicy,
            executionPolicy: LOOP_AGENT_CAPABILITIES,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Loop harness bridge returned HTTP ${response.status}`);
        }
        const parsed = parseBridgeReply(await response.json(), input);
        if (!parsed) throw new Error('Loop harness bridge returned an invalid or unsafe reply');
        return { turnId: parsed.turnId, text: parsed.text, generatedAt: parsed.generatedAt };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
