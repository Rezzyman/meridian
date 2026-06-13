/**
 * http_request must route through the SSRF guard (a blocked target returns a
 * structured 'blocked' result, no fetch), honor allowPrivate to reach a
 * trusted loopback server, cap the body, and surface failures as data.
 * extract_text must strip markup to readable text.
 */

import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Tool } from 'ai';
import { htmlToText, webTools } from '../../src/skills/builtin/web-tools.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };
const http = webTools.http_request as Required<Tool>;

describe('http_request — SSRF guard is enforced before any fetch', () => {
  it('blocks the cloud-metadata endpoint without making a request', async () => {
    const res = (await http.execute(
      { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'blocked');
    assert.match(res.reason as string, /link_local/);
  });

  it('blocks loopback by default', async () => {
    const res = (await http.execute(
      { url: 'http://127.0.0.1:9/', method: 'GET' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'blocked');
  });
});

describe('http_request — reaches a trusted server when allowPrivate is set', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(2_000_000)); // exceeds the 1 MB cap
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'meridian' });
      res.end(JSON.stringify({ method: req.method, url: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => {
    server.close();
  });

  it('returns a structured response with headers and body', async () => {
    const res = (await http.execute(
      { url: `${base}/echo`, method: 'GET', allowPrivate: true },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal((res.headers as Record<string, string>)['x-test'], 'meridian');
    assert.deepEqual(JSON.parse(res.body as string), { method: 'GET', url: '/echo' });
    assert.equal(res.truncated, false);
  });

  it('passes a POST body through', async () => {
    const res = (await http.execute(
      { url: `${base}/submit`, method: 'POST', body: 'payload', allowPrivate: true },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, true);
    assert.deepEqual(JSON.parse(res.body as string), { method: 'POST', url: '/submit' });
  });

  it('caps the body at 1 MB and flags truncation', async () => {
    const res = (await http.execute(
      { url: `${base}/big`, method: 'GET', allowPrivate: true },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.equal((res.body as string).length, 1_000_000);
    assert.equal(res.bytes, 2_000_000);
  });
});

describe('extract_text / htmlToText', () => {
  it('strips scripts, styles, and tags and decodes entities', () => {
    const html =
      '<html><head><style>.a{color:red}</style><script>evil()</script></head>' +
      '<body><h1>Title</h1><p>Hello &amp; welcome to &lt;MERIDIAN&gt;</p>' +
      '<div>line<br>break</div></body></html>';
    const out = htmlToText(html);
    // No script/style payload, and no surviving tags (the decoded literal
    // "<MERIDIAN>" is content, not markup, and is expected to remain).
    assert.doesNotMatch(out, /evil|color:red|<\/?(p|div|h1|br|script|style)\b/i);
    assert.match(out, /Title/);
    assert.match(out, /Hello & welcome to <MERIDIAN>/);
    assert.match(out, /line\nbreak/);
  });

  it('decodes numeric entities', () => {
    assert.match(htmlToText('<p>caf&#233; &#x2014; ok</p>'), /café — ok/);
  });

  it('tool reports char count and truncation', async () => {
    const tool = webTools.extract_text as Required<Tool>;
    const res = (await tool.execute(
      { html: '<p>hello world</p>', maxChars: 5 },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.text, 'hello');
    assert.equal(res.truncated, true);
    assert.equal(res.chars, 11);
  });
});
