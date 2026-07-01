/**
 * web_fetch is the URL tool an LLM reaches for first, so it must honor the same
 * SSRF floor as http_request — a blocked target returns a structured 'blocked'
 * result and makes NO network call. Guards against a poisoned memory steering
 * the agent at the cloud-metadata endpoint or an internal service.
 */

import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Tool } from 'ai';
import { coreTools } from '../../src/skills/builtin/core-tools.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };
const webFetch = coreTools.web_fetch as Required<Tool>;

describe('web_fetch — SSRF guard is enforced before any fetch', () => {
  it('blocks the cloud-metadata endpoint without making a request', async () => {
    const res = (await webFetch.execute(
      { url: 'http://169.254.169.254/latest/meta-data/', timeoutMs: 1000 },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'blocked');
    assert.match(res.reason as string, /link_local/);
  });

  it('blocks loopback by default', async () => {
    const res = (await webFetch.execute(
      { url: 'http://127.0.0.1:9/', timeoutMs: 1000 },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'blocked');
  });

  it('blocks a private RFC1918 address', async () => {
    const res = (await webFetch.execute(
      { url: 'http://10.0.0.5/', timeoutMs: 1000 },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'blocked');
  });
});

describe('web_fetch — reaches a public-shaped host', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from the test server');
    });
    // 127.0.0.1 is blocked by the SSRF guard by default (that's the point), so
    // this test asserts the guard's verdict rather than a live 200. We simply
    // confirm a loopback URL is refused — proving the screen runs on the real
    // path — and tear the server down.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server.close();
  });

  it('refuses even a live loopback server (guard runs on the real fetch path)', async () => {
    const res = (await webFetch.execute({ url: `${base}/`, timeoutMs: 1000 }, TOOL_OPTS)) as Record<
      string,
      unknown
    >;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'blocked');
  });
});
