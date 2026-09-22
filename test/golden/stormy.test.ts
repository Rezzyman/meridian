import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { AgentConfigSchema } from '../../src/config/schema.js';
import { evaluateActionPolicy } from '../../src/governance/action-policy.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = join(repo, 'examples', 'golden', 'stormy');
const source = readFileSync(join(root, 'config.yaml'), 'utf8');
const config = AgentConfigSchema.parse(parse(source));

describe('Stormy golden governed agent', () => {
  it('is schema-valid, Routexor-only, and safe by default', () => {
    assert.match(config.models.primary, /^routexor\//);
    assert.ok(config.models.fallbacks.every((model) => model.startsWith('routexor/')));
    assert.equal(config.channels.telegram.enabled, false);
    assert.equal(config.channels.gateway.enabled, false);
    assert.equal(config.heartbeat.enabled, false);
    assert.equal(config.dream.enabled, false);
    assert.equal(config.proactive?.enabled, false);
    assert.equal(config.delegation?.enabled, false);
  });

  it('uses hardened memory provenance and domain-safe vision instructions', () => {
    assert.equal(config.cortex.provenanceTrust, 'signed');
    assert.equal(config.cortex.memoryLlmJudge, true);
    const prompt = config.vision.prompt?.toLowerCase() ?? '';
    for (const term of [
      'observations',
      'inferences',
      'conclusions',
      'confidence',
      'limitations',
      'causation',
    ]) {
      assert.match(prompt, new RegExp(term));
    }
  });

  it('denies dangerous actions even for a trusted operator', () => {
    for (const toolName of ['bash', 'write', 'edit_file', 'run_code', 'http_request', 'delegate']) {
      const decision = evaluateActionPolicy(config, {
        agentId: 'stormy',
        sessionId: 'synthetic',
        channel: 'cli',
        senderTrusted: true,
        toolName,
        callIndex: 1,
      });
      assert.equal(decision.decision, 'deny', toolName);
      assert.equal(decision.rule, 'denyTools', toolName);
    }
  });

  it('requires scoped approval for outbound messaging', () => {
    const base = {
      agentId: 'stormy',
      sessionId: 'synthetic',
      channel: 'cli' as const,
      senderTrusted: true,
      toolName: 'telegram_dm',
      callIndex: 1,
    };
    assert.equal(evaluateActionPolicy(config, base).rule, 'approvalRequired');
    assert.equal(
      evaluateActionPolicy(config, { ...base, approvalGranted: true }).decision,
      'allow',
    );
  });

  it('contains no obvious credentials or customer data', () => {
    const bundle = [
      source,
      readFileSync(join(root, 'IDENTITY', 'AGENT.md'), 'utf8'),
      readFileSync(join(root, 'README.md'), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(bundle, /(?:sk-|xox[baprs]-|AIza|-----BEGIN [A-Z ]+PRIVATE KEY-----)/);
    assert.doesNotMatch(bundle, /\b\d{3}-\d{2}-\d{4}\b/);
  });
});
