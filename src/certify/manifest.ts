import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Capability manifest (certification step 1).
 *
 * One file per agent, `CAPABILITIES/manifest.yaml`, listing what the agent
 * PROMISES to do. Every claim carries a probe. A capability is not "available"
 * until its probe passes against a real gateway; `meridian certify` is the
 * gate. Nothing gets into the manifest without a probe, and nothing in the
 * roadmap counts as a capability.
 */
export const ProbeSchema = z.discriminatedUnion('kind', [
  // Gateway-level facts read from GET /health.
  z.object({
    kind: z.literal('health'),
    field: z.string(),
    equals: z.unknown().optional(),
    truthy: z.boolean().optional(),
  }),
  // A token-authenticated turn must produce a non-empty reply within a deadline.
  z.object({
    kind: z.literal('turn'),
    input: z.string(),
    mustMatch: z.array(z.string()).default([]),
    mustNotMatch: z.array(z.string()).default([]),
    withinMs: z.number().int().positive().default(30_000),
  }),
  // Store a fact on a fresh session, then poll a fresh session until it is recalled (or time out).
  z.object({
    kind: z.literal('memory'),
    seed: z.string(),
    ask: z.string(),
    expect: z.string(),
    withinMs: z.number().int().positive().default(90_000),
  }),
  // Every named tool must be present on the gateway's tool surface.
  z.object({ kind: z.literal('tools'), names: z.array(z.string()).min(1) }),
  // Named automation must be armed with a next fire time and a delivering policy.
  z.object({
    kind: z.literal('automation'),
    name: z.string(),
    delivers: z.boolean().default(true),
  }),
  // An HTTP endpoint must answer 2xx (voice webhook health, relay ping).
  z.object({
    kind: z.literal('http'),
    url: z.string().url(),
    withinMs: z.number().int().positive().default(8000),
  }),
  // The Loop synthetic canary must pass against this gateway or sidecar.
  z.object({
    kind: z.literal('loop-canary'),
    url: z.string().url(),
    tokenEnv: z.string().default('MERIDIAN_LOOP_TOKEN'),
  }),
  // A human must confirm (e.g. "reply arrived on iMessage as blue bubbles"). Recorded, never auto-green.
  z.object({ kind: z.literal('manual'), instruction: z.string() }),
]);
export type Probe = z.infer<typeof ProbeSchema>;

export const CapabilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  claim: z.string().min(1),
  /** Marks a claim as an operator channel. Certification requires at least
   *  one channel claim green: an agent must be reachable the way its person
   *  already communicates (phone number over iMessage/SMS, the Loop app,
   *  Telegram, Slack...), and never certified with no working channel. */
  channel: z.boolean().default(false),
  /** blocking: red fails certification. advisory: red is reported, not fatal. */
  severity: z.enum(['blocking', 'advisory']).default('blocking'),
  probe: ProbeSchema,
});
export type Capability = z.infer<typeof CapabilitySchema>;

/** Golden set (certification step 2): the agent's own job, as prompts with
 *  deterministic checks, run on every certification. The file uses the parity
 *  bench prompt shape. */
export const GoldenSetSchema = z.object({
  file: z.string().min(1),
  /** Fraction of golden prompts that must pass. */
  minPassRate: z.number().min(0).max(1).default(0.8),
  severity: z.enum(['blocking', 'advisory']).default('blocking'),
});

export const CapabilityManifestSchema = z.object({
  schema: z.literal('meridian.capabilities.v1'),
  agent: z.string().min(1),
  golden: GoldenSetSchema.optional(),
  /** Who this agent serves; decides which probes are mandatory (see required()). */
  audience: z.enum(['internal', 'client-facing']),
  capabilities: z.array(CapabilitySchema).min(1),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export function loadManifest(path: string): CapabilityManifest {
  const raw = parseYaml(readFileSync(path, 'utf8'));
  const manifest = CapabilityManifestSchema.parse(raw);
  const ids = new Set<string>();
  for (const c of manifest.capabilities) {
    if (ids.has(c.id)) throw new Error(`duplicate capability id: ${c.id}`);
    ids.add(c.id);
  }
  return manifest;
}

/**
 * Probes every manifest must carry, by audience. Certification refuses a
 * manifest that omits them: a client-facing agent that never proved it keeps
 * internal names off the wire is not certified, whatever else it can do.
 */
export function requiredCapabilityIds(audience: CapabilityManifest['audience']): string[] {
  const base = [
    'gateway.health',
    'provider.posture',
    'memory.reachable',
    'memory.roundtrip',
    'spend.caps',
    'timezone',
  ];
  return audience === 'client-facing'
    ? [...base, 'brand.no-internal-names', 'privacy.stranger-refusal']
    : base;
}

export function missingRequired(manifest: CapabilityManifest): string[] {
  const have = new Set(manifest.capabilities.map((c) => c.id));
  const missing = requiredCapabilityIds(manifest.audience).filter((id) => !have.has(id));
  if (!manifest.capabilities.some((c) => c.channel))
    missing.push('channel.any (no claim is marked channel: true)');
  return missing;
}
