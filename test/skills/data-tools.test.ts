/**
 * Pure utility tools: known-answer vectors for hashing, round-trip + error
 * handling for base64, and shape for current_time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Tool } from 'ai';
import { dataTools } from '../../src/skills/builtin/data-tools.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };
const hash = dataTools.hash_text as Required<Tool>;
const b64 = dataTools.base64_transform as Required<Tool>;
const time = dataTools.current_time as Required<Tool>;

describe('hash_text — known-answer vectors', () => {
  const vectors: Array<[string, 'sha256' | 'sha1' | 'md5', string]> = [
    ['abc', 'sha256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abc', 'sha1', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['abc', 'md5', '900150983cd24fb0d6963f7d28e17f72'],
    ['', 'sha256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ];
  for (const [text, algorithm, expected] of vectors) {
    it(`${algorithm}("${text}")`, async () => {
      const res = (await hash.execute({ text, algorithm }, TOOL_OPTS)) as Record<string, unknown>;
      assert.equal(res.hex, expected);
      assert.equal(res.algorithm, algorithm);
    });
  }
});

describe('base64_transform', () => {
  it('encodes and decodes round-trip', async () => {
    const enc = (await b64.execute(
      { input: 'hello', mode: 'encode' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.deepEqual(enc, { ok: true, result: 'aGVsbG8=' });
    const dec = (await b64.execute(
      { input: 'aGVsbG8=', mode: 'decode' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.deepEqual(dec, { ok: true, result: 'hello' });
  });

  it('uses the url-safe alphabet and round-trips', async () => {
    const enc = (await b64.execute(
      { input: '<<>>', mode: 'encode', urlSafe: true },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(enc.result, 'PDw-Pg'); // standard 'PDw+Pg==' → url-safe, unpadded
    const dec = (await b64.execute(
      { input: enc.result as string, mode: 'decode', urlSafe: true },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(dec.result, '<<>>');
  });

  it('returns a structured error for invalid base64 instead of throwing', async () => {
    const res = (await b64.execute(
      { input: 'not valid base64!!', mode: 'decode' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.match(res.error as string, /not valid base64/);
  });
});

describe('current_time', () => {
  it('returns iso + epoch + timezone', async () => {
    const res = (await time.execute({}, TOOL_OPTS)) as Record<string, unknown>;
    assert.match(res.iso as string, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(typeof res.epochMs, 'number');
    assert.ok((res.epochMs as number) > 1_700_000_000_000);
    assert.equal(typeof res.timeZone, 'string');
  });

  it('honors an explicit timezone without throwing on a bad one', async () => {
    const res = (await time.execute({ timeZone: 'America/New_York' }, TOOL_OPTS)) as Record<
      string,
      unknown
    >;
    assert.equal(res.timeZone, 'America/New_York');
  });
});
