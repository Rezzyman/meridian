/**
 * resolveOperator + operatorSessionId — pure identity-resolution logic.
 * Table-driven: channel-specific identifiers map to the canonical operator
 * id from config, or fall back to unknown:<channel>:<from>.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorSessionId, resolveOperator } from '../../src/agent/operator.js';
import type { ChannelKind } from '../../src/agent/operator.js';
import { makeConfig } from '../helpers/fixtures.js';

const cfg = makeConfig({
  operator: {
    id: 'rez',
    channels: {
      telegram: ['123456789'],
      voice: ['+1 (303) 997-1189'],
      cli: ['Rez', 'root'],
    },
  },
});

interface Case {
  name: string;
  channel: ChannelKind;
  from: string;
  wantId: string;
  wantSource: 'config' | 'unknown';
}

const cases: Case[] = [
  // telegram: exact chat-id string match, no normalisation
  {
    name: 'telegram exact chat-id match',
    channel: 'telegram',
    from: '123456789',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'telegram unrecognised chat id falls back to unknown',
    channel: 'telegram',
    from: '999',
    wantId: 'unknown:telegram:999',
    wantSource: 'unknown',
  },
  {
    name: 'telegram match is exact — whitespace is not stripped',
    channel: 'telegram',
    from: ' 123456789',
    wantId: 'unknown:telegram: 123456789',
    wantSource: 'unknown',
  },
  // voice: spaces/parens/dashes/+ stripped on BOTH sides before comparing
  {
    name: 'voice exact formatted number matches itself',
    channel: 'voice',
    from: '+1 (303) 997-1189',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'voice bare digits match formatted config number',
    channel: 'voice',
    from: '13039971189',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'voice +E.164 matches formatted config number',
    channel: 'voice',
    from: '+13039971189',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'voice dashed caller matches formatted config number',
    channel: 'voice',
    from: '1-303-997-1189',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'voice unrecognised number falls back to unknown',
    channel: 'voice',
    from: '+1 (415) 555-0100',
    wantId: 'unknown:voice:+1 (415) 555-0100',
    wantSource: 'unknown',
  },
  // cli: case-insensitive OS username comparison
  {
    name: 'cli lowercased username matches mixed-case config entry',
    channel: 'cli',
    from: 'rez',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'cli uppercased username matches',
    channel: 'cli',
    from: 'REZ',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'cli alias (root) matches case-insensitively',
    channel: 'cli',
    from: 'ROOT',
    wantId: 'rez',
    wantSource: 'config',
  },
  {
    name: 'cli unrecognised username falls back to unknown',
    channel: 'cli',
    from: 'mallory',
    wantId: 'unknown:cli:mallory',
    wantSource: 'unknown',
  },
  // channels with no operator mapping never match config
  {
    name: 'gateway channel has no operator mapping — always unknown',
    channel: 'gateway',
    from: '123456789',
    wantId: 'unknown:gateway:123456789',
    wantSource: 'unknown',
  },
];

for (const c of cases) {
  test(`resolveOperator: ${c.name}`, () => {
    const r = resolveOperator(cfg, c.channel, c.from);
    assert.equal(r.id, c.wantId);
    assert.equal(r.source, c.wantSource);
    assert.equal(r.channel, c.channel);
    assert.equal(r.from, c.from, 'raw channel identifier is preserved verbatim');
  });
}

test('resolveOperator: no operator config → unknown:<channel>:<from>', () => {
  const noOp = makeConfig(); // defaultAgentConfig has no operator block
  const r = resolveOperator(noOp, 'telegram', '123456789');
  assert.equal(r.id, 'unknown:telegram:123456789');
  assert.equal(r.source, 'unknown');
});

test('resolveOperator: empty from falls back to anon in the id, raw from stays empty', () => {
  const r = resolveOperator(cfg, 'voice', '');
  assert.equal(r.id, 'unknown:voice:anon');
  assert.equal(r.source, 'unknown');
  assert.equal(r.from, '');
});

test('operatorSessionId prefixes with op:', () => {
  assert.equal(operatorSessionId('rez'), 'op:rez');
  assert.equal(operatorSessionId('unknown:cli:anon'), 'op:unknown:cli:anon');
});
