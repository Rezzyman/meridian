/**
 * SSRF guard — the safety floor under every outbound HTTP tool.
 *
 * An agent that can fetch arbitrary URLs is an SSRF primitive: a poisoned
 * memory ("check the status page at http://169.254.169.254/latest/meta-data/
 * iam/security-credentials/") can turn the agent into a confused deputy that
 * reads cloud-instance credentials, hits internal admin panels, or probes the
 * RFC-1918 network the host sits on. Every harness that ships an HTTP tool
 * inherits this exposure; MERIDIAN refuses the dangerous-target class BY
 * DEFAULT and makes the operator opt in (`allowPrivate`) to leave it.
 *
 * The non-obvious part is normalization. `127.0.0.1`, `2130706433`,
 * `0x7f000001`, `0177.0.0.1`, `127.1`, and `::ffff:127.0.0.1` are all the
 * loopback — attackers reach for the obscure encodings precisely because naive
 * string checks miss them. We parse the host the way the OS resolver would
 * (inet_aton semantics + IPv6 literals) and range-check the real address.
 *
 * Residual (documented, not hidden): a public hostname whose DNS later
 * resolves to a private address (DNS rebinding) is NOT caught here without a
 * resolve step. `screenUrl` is synchronous and offline by design; the optional
 * resolver hook in `httpRequest` closes this when callers want it.
 */

export type SsrfReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'no_host'
  | 'loopback'
  | 'unspecified'
  | 'private'
  | 'carrier_grade_nat'
  | 'link_local'
  | 'unique_local'
  | 'localhost_name';

export interface UrlScreen {
  ok: boolean;
  /** Present when ok === false. */
  reason?: SsrfReason;
  /** The parsed hostname (lowercased, brackets stripped). */
  host?: string;
  /** Dotted-quad / canonical form when the host was an IP literal. */
  ip?: string;
}

export interface ScreenOptions {
  /** Skip the private/loopback/link-local range checks. Scheme is still
   *  enforced. Off by default — this is the operator's explicit "yes, I mean
   *  to reach my LAN" switch. */
  allowPrivate?: boolean;
  /** Allowed URL schemes. Defaults to http/https only — no file:, gopher:,
   *  ftp:, data:, which are the other half of the SSRF toolkit. */
  allowedSchemes?: string[];
}

const DEFAULT_SCHEMES = ['http:', 'https:'];

/**
 * Parse a host as a loose IPv4 the way inet_aton / the OS resolver does —
 * accepting decimal, hex (0x..), and octal (0..) parts and the short forms
 * (a, a.b, a.b.c) where the final part absorbs the remaining bytes. Returns
 * the 32-bit address as a number, or null if the host is not an IPv4 literal
 * in any of these encodings (i.e. it's a real hostname).
 */
export function parseLooseIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      value = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = Number.parseInt(part.slice(1), 8);
    } else if (/^[0-9]+$/.test(part)) {
      value = Number.parseInt(part, 10);
    } else {
      return null; // a non-numeric label → not an IP literal
    }
    if (!Number.isFinite(value) || value < 0) return null;
    nums.push(value);
  }

  // inet_aton: the last part fills all remaining low-order bytes; earlier
  // parts are one byte each.
  const n = nums.length;
  for (let i = 0; i < n - 1; i++) {
    if (nums[i] > 0xff) return null;
  }
  const last = nums[n - 1];
  const remainingBytes = 4 - (n - 1);
  const maxLast = remainingBytes === 4 ? 0xffffffff : 2 ** (8 * remainingBytes) - 1;
  if (last > maxLast) return null;

  let addr = 0;
  for (let i = 0; i < n - 1; i++) addr = (addr | (nums[i] << (8 * (3 - i)))) >>> 0;
  addr = (addr | last) >>> 0;
  return addr;
}

function classifyIPv4(addr: number): SsrfReason | null {
  const a = (addr >>> 24) & 0xff;
  const b = (addr >>> 16) & 0xff;
  if (a === 0) return 'unspecified'; // 0.0.0.0/8 "this network"
  if (a === 127) return 'loopback'; // 127.0.0.0/8
  if (a === 10) return 'private'; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
  if (a === 169 && b === 254) return 'link_local'; // 169.254.0.0/16 (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return 'carrier_grade_nat'; // 100.64.0.0/10
  return null;
}

function dotted(addr: number): string {
  return [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff].join('.');
}

/**
 * Expand an IPv6 literal (brackets-stripped, lowercased) to its 8 hextets,
 * handling `::` zero-compression and an embedded IPv4 dotted-quad tail. Returns
 * null if the host is not a syntactically valid IPv6 literal. We expand fully
 * rather than pattern-match the head because `new URL()` canonicalizes
 * addresses (`::ffff:127.0.0.1` → `::ffff:7f00:1`), so a naive string check
 * would miss the very forms an attacker reaches for.
 */
export function parseIPv6(host: string): number[] | null {
  if (!host.includes(':')) return null;

  // Fold an embedded IPv4 tail (::ffff:127.0.0.1, ::127.0.0.1) into two hextets.
  let s = host;
  const v4tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4tail) {
    const v4 = parseLooseIPv4(v4tail[1]);
    if (v4 === null) return null;
    s = `${s.slice(0, v4tail.index)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null; // more than one '::' is invalid
  const toHextets = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const out: number[] = [];
    for (const g of chunk.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const head = toHextets(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = toHextets(halves[1]);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/**
 * Classify an IPv6 literal by range: loopback, unspecified, link-local
 * (fe80::/10), unique-local (fc00::/7), and IPv4-mapped/-compatible addresses
 * (whose embedded IPv4 is screened with the v4 classifier).
 */
function classifyIPv6(host: string): { reason: SsrfReason | null; ip: string } | null {
  const h = parseIPv6(host);
  if (h === null) return null;
  const leadingZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;

  if (leadingZero && h[5] === 0 && h[6] === 0 && h[7] === 1) return { reason: 'loopback', ip: host };
  if (h.every((x) => x === 0)) return { reason: 'unspecified', ip: host };

  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) tunnel an IPv4 target.
  if (leadingZero && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = (((h[6] << 16) | h[7]) >>> 0) as number;
    const reason = classifyIPv4(v4);
    if (reason) return { reason, ip: dotted(v4) };
  }

  if ((h[0] & 0xffc0) === 0xfe80) return { reason: 'link_local', ip: host }; // fe80::/10
  if ((h[0] & 0xfe00) === 0xfc00) return { reason: 'unique_local', ip: host }; // fc00::/7
  return { reason: null, ip: host };
}

/**
 * Screen a URL for SSRF safety. Synchronous and offline: it normalizes the
 * host and range-checks IP literals; it does NOT resolve DNS (see the module
 * residual note). Returns `{ ok: true, host }` for a permitted URL, or
 * `{ ok: false, reason }` for a rejected one.
 */
export function screenUrl(raw: string, opts: ScreenOptions = {}): UrlScreen {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const schemes = opts.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(url.protocol)) return { ok: false, reason: 'scheme_not_allowed' };

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return { ok: false, reason: 'no_host' };

  if (opts.allowPrivate) return { ok: true, host };

  // Local-name forms that never need DNS: localhost and friends, plus mDNS
  // .local. We block by default; allowPrivate is the escape hatch.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'ip6-localhost' ||
    host === 'ip6-loopback' ||
    host.endsWith('.local')
  ) {
    return { ok: false, reason: 'localhost_name', host };
  }

  const v6 = classifyIPv6(host);
  if (v6) {
    if (v6.reason) return { ok: false, reason: v6.reason, host, ip: v6.ip };
    return { ok: true, host, ip: v6.ip };
  }

  const v4 = parseLooseIPv4(host);
  if (v4 !== null) {
    const reason = classifyIPv4(v4);
    if (reason) return { ok: false, reason, host, ip: dotted(v4) };
    return { ok: true, host, ip: dotted(v4) };
  }

  // A regular hostname. Permitted (DNS-rebinding residual is documented).
  return { ok: true, host };
}
