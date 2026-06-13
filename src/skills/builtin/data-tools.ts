/**
 * Data tools — small, pure, dependency-free utilities the model otherwise
 * fakes by "computing in its head": hashing, base64, and the current time.
 *
 * These are harmless (no I/O, no secrets, no egress), so they default ON for
 * every channel. The win is correctness: a model asked for a SHA-256 will
 * confidently hallucinate one; a tool returns the real digest.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../toolkit.js';

export const dataTools = {
  hash_text: defineTool({
    description: 'Compute a cryptographic hash (sha256/sha1/sha512/md5) of a UTF-8 string. Returns the hex digest.',
    parameters: z.object({
      text: z.string(),
      algorithm: z.enum(['sha256', 'sha1', 'sha512', 'md5']).default('sha256'),
    }),
    output: z.object({ algorithm: z.string(), hex: z.string(), bytes: z.number().int() }),
    execute: ({ text, algorithm }) => {
      const hex = createHash(algorithm).update(text, 'utf8').digest('hex');
      return { algorithm, hex, bytes: Buffer.byteLength(text) };
    },
  }),

  base64_transform: defineTool({
    description:
      'Encode a UTF-8 string to base64, or decode a base64 string back to UTF-8. Set urlSafe for the ' +
      'URL/filename-safe alphabet. Decode failures come back as a structured error, never a throw.',
    parameters: z.object({
      input: z.string(),
      mode: z.enum(['encode', 'decode']),
      urlSafe: z.boolean().default(false),
    }),
    output: z.union([
      z.object({ ok: z.literal(true), result: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    execute: ({ input, mode, urlSafe }) => {
      if (mode === 'encode') {
        const b64 = Buffer.from(input, 'utf8').toString('base64');
        return { ok: true as const, result: urlSafe ? toUrlSafe(b64) : b64 };
      }
      const normal = urlSafe ? fromUrlSafe(input) : input;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normal)) {
        return { ok: false as const, error: 'input is not valid base64' };
      }
      const decoded = Buffer.from(normal, 'base64');
      return { ok: true as const, result: decoded.toString('utf8') };
    },
  }),

  current_time: defineTool({
    description:
      'Return the current time as an ISO-8601 UTC string, the Unix epoch in milliseconds, and the ' +
      'local timezone. Use instead of guessing "now".',
    parameters: z.object({
      timeZone: z.string().optional(),
    }),
    output: z.object({
      iso: z.string(),
      epochMs: z.number().int(),
      timeZone: z.string(),
      local: z.string(),
    }),
    execute: ({ timeZone }) => {
      const now = new Date();
      const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      let local: string;
      try {
        local = now.toLocaleString('en-US', { timeZone: tz });
      } catch {
        local = now.toLocaleString('en-US');
      }
      return { iso: now.toISOString(), epochMs: now.getTime(), timeZone: tz, local };
    },
  }),
};

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUrlSafe(s: string): string {
  const restored = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = restored.length % 4 === 0 ? '' : '='.repeat(4 - (restored.length % 4));
  return restored + pad;
}
