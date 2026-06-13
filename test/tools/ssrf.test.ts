/**
 * The SSRF guard is the safety floor under every outbound HTTP tool, so it
 * gets adversarial coverage: the famous obfuscated-loopback encodings
 * (decimal/hex/octal/short-form), the cloud-metadata link-local address, the
 * RFC-1918 ranges, IPv6 loopback / link-local / unique-local / v4-mapped, and
 * the non-http schemes — all must be REJECTED; real public destinations must
 * PASS; and `allowPrivate` must be the only thing that opens the private set.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLooseIPv4, screenUrl, type SsrfReason } from '../../src/tools/ssrf.js';

describe('screenUrl — blocks the SSRF target class by default', () => {
  const blocked: Array<[string, SsrfReason]> = [
    // localhost name forms (no DNS needed)
    ['http://localhost/', 'localhost_name'],
    ['http://api.localhost/v1', 'localhost_name'],
    ['http://printer.local/', 'localhost_name'],
    // loopback, including the obfuscations attackers actually use
    ['http://127.0.0.1/', 'loopback'],
    ['http://127.1/', 'loopback'], // short form
    ['http://2130706433/', 'loopback'], // decimal
    ['http://0x7f000001/', 'loopback'], // hex
    ['http://0177.0.0.1/', 'loopback'], // octal first octet
    ['http://0/', 'unspecified'], // 0.0.0.0
    // RFC-1918 private
    ['http://10.0.0.5/', 'private'],
    ['http://172.16.0.1/', 'private'],
    ['http://172.31.255.255/', 'private'],
    ['http://192.168.1.1:8080/admin', 'private'],
    // the one that matters most: cloud instance metadata
    ['http://169.254.169.254/latest/meta-data/', 'link_local'],
    ['http://100.64.0.1/', 'carrier_grade_nat'],
    // IPv6
    ['http://[::1]/', 'loopback'],
    ['http://[::ffff:127.0.0.1]/', 'loopback'], // v4-mapped loopback
    ['http://[fe80::1]/', 'link_local'],
    ['http://[fc00::1]/', 'unique_local'],
    ['http://[fd12:3456:789a::1]/', 'unique_local'],
    // schemes that are SSRF tooling in their own right
    ['ftp://example.com/', 'scheme_not_allowed'],
    ['file:///etc/passwd', 'scheme_not_allowed'],
    ['gopher://example.com:70/', 'scheme_not_allowed'],
  ];
  for (const [url, reason] of blocked) {
    it(`blocks ${url} (${reason})`, () => {
      const r = screenUrl(url);
      assert.equal(r.ok, false, `expected block, got ok for ${url}`);
      assert.equal(r.reason, reason);
    });
  }

  it('rejects a non-URL string', () => {
    assert.equal(screenUrl('not a url').reason, 'invalid_url');
  });
});

describe('screenUrl — permits real public destinations', () => {
  const allowed = [
    'http://example.com/',
    'https://api.github.com/repos/o/r',
    'http://8.8.8.8/', // public IP literal
    'http://172.32.0.1/', // just outside 172.16/12
    'http://192.169.0.1/', // not 192.168/16
    'https://[2606:4700:4700::1111]/', // public IPv6 (cloudflare dns)
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      assert.equal(screenUrl(url).ok, true, `expected allow for ${url}`);
    });
  }
});

describe('screenUrl — allowPrivate is the only escape hatch', () => {
  it('opens loopback when allowPrivate is set', () => {
    assert.equal(screenUrl('http://127.0.0.1:5432/', { allowPrivate: true }).ok, true);
    assert.equal(screenUrl('http://169.254.169.254/', { allowPrivate: true }).ok, true);
  });
  it('still enforces the scheme even with allowPrivate', () => {
    assert.equal(
      screenUrl('file:///etc/passwd', { allowPrivate: true }).reason,
      'scheme_not_allowed',
    );
  });
});

describe('parseLooseIPv4 — inet_aton-style normalization', () => {
  const cases: Array<[string, number | null]> = [
    ['127.0.0.1', 0x7f000001],
    ['2130706433', 0x7f000001],
    ['0x7f000001', 0x7f000001],
    ['127.1', 0x7f000001],
    ['1.2.3.4', 0x01020304],
    ['255.255.255.255', 0xffffffff],
    ['example.com', null], // real hostname
    ['localhost', null],
    ['256.1.1.1', null], // octet overflow
    ['1.2.3.4.5', null], // too many parts
  ];
  for (const [host, expected] of cases) {
    it(`${host} → ${expected === null ? 'null' : `0x${expected.toString(16)}`}`, () => {
      const got = parseLooseIPv4(host);
      if (expected === null) assert.equal(got, null);
      else assert.equal(got! >>> 0, expected >>> 0);
    });
  }
});
