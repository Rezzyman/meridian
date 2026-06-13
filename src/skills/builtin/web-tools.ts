/**
 * Web tools — a real HTTP client and an HTML→text extractor.
 *
 * `web_fetch` (core-tools) is GET-only and returns raw text. Agents that
 * integrate with APIs need methods, headers, and request bodies — so this is
 * `http_request`, the fuller tool. Crucially it routes EVERY request through
 * the SSRF guard (src/tools/ssrf.ts): a poisoned instruction cannot steer it
 * at the cloud-metadata endpoint or the host's LAN unless the operator set
 * `allowPrivate`. Output is size-capped and schema-validated.
 *
 * `extract_text` turns a fetched HTML page into readable plain text so the
 * model isn't reasoning over markup — pairs with either fetch tool.
 */

import { z } from 'zod';
import { defineTool } from '../toolkit.js';
import { screenUrl } from '../../tools/ssrf.js';

const MAX_BODY_BYTES = 1_000_000; // 1 MB hard cap on what re-enters the model

const HttpHeaders = z.record(z.string(), z.string());

const HttpRequestOut = z.union([
  z.object({
    ok: z.boolean(),
    status: z.number().int(),
    statusText: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
    truncated: z.boolean(),
    bytes: z.number().int(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['blocked', 'request_failed']),
    reason: z.string(),
  }),
]);

export const webTools = {
  http_request: defineTool({
    description:
      'Make an HTTP request (GET/POST/PUT/PATCH/DELETE/HEAD) with optional headers and a body. ' +
      'Outbound requests to loopback, private (RFC-1918), link-local/cloud-metadata, and unique-local ' +
      'addresses are BLOCKED by default for safety; set allowPrivate only for a trusted local target. ' +
      'Response body is capped at 1 MB.',
    parameters: z.object({
      url: z.string().url(),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
        .default('GET'),
      headers: HttpHeaders.optional(),
      body: z.string().optional(),
      timeoutMs: z.number().int().min(1).max(120_000).default(20_000),
      allowPrivate: z.boolean().default(false),
    }),
    output: HttpRequestOut,
    execute: async ({ url, method, headers, body, timeoutMs, allowPrivate }) => {
      const screen = screenUrl(url, { allowPrivate });
      if (!screen.ok) {
        return {
          ok: false as const,
          error: 'blocked' as const,
          reason: `SSRF guard: ${screen.reason}${screen.ip ? ` (${screen.ip})` : ''}`,
        };
      }
      try {
        // Schema defaults are applied by the model runtime, but execute is
        // also reachable directly (delegate/MCP/tests) — fall back in-band.
        const res = await fetch(url, {
          method: method ?? 'GET',
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: AbortSignal.timeout(timeoutMs ?? 20_000),
          redirect: 'manual', // a 3xx Location could redirect into a blocked host
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const truncated = buf.byteLength > MAX_BODY_BYTES;
        const slice = truncated ? buf.subarray(0, MAX_BODY_BYTES) : buf;
        const outHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          outHeaders[k] = v;
        });
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: outHeaders,
          body: slice.toString('utf8'),
          truncated,
          bytes: buf.byteLength,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: 'request_failed' as const,
          reason: (err as Error).message,
        };
      }
    },
  }),

  extract_text: defineTool({
    description:
      'Strip HTML to readable plain text: removes <script>/<style>, drops tags, decodes common ' +
      'entities, and collapses whitespace. Use on a fetched HTML page before reasoning over it.',
    parameters: z.object({
      html: z.string(),
      maxChars: z.number().int().min(1).max(500_000).default(100_000),
    }),
    output: z.object({ text: z.string(), chars: z.number().int(), truncated: z.boolean() }),
    execute: ({ html, maxChars }) => {
      const text = htmlToText(html);
      const truncated = text.length > maxChars;
      const out = truncated ? text.slice(0, maxChars) : text;
      return { text: out, chars: text.length, truncated };
    },
  }),
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
};

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?[a-z0-9]+);/gi, (m, code: string) => {
      const lower = code.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower];
      if (/^#\d+$/.test(code)) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      if (/^#x[0-9a-f]+$/i.test(code))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      return m;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
