import dns from 'dns/promises';
import net from 'net';

/**
 * URL and network policy for the browser. Every URL the browser may touch (typed by the model, followed as a
 * redirect, or requested by the page itself) is checked here: scheme, credentials, host allow/block lists,
 * and that the host resolves ONLY to public addresses (loopback, private, link-local and cloud-metadata
 * ranges are refused). The check is repeated for every request, so redirects cannot walk the browser inward.
 */

export class UrlPolicyError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_URL'
      | 'UNSUPPORTED_SCHEME'
      | 'CREDENTIALS_IN_URL'
      | 'BLOCKED_HOST'
      | 'PRIVATE_ADDRESS'
      | 'HOST_NOT_ALLOWED'
      | 'OUT_OF_SCOPE'
      | 'DNS_FAILURE'
      | 'BAD_PORT',
    message: string
  ) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

export interface UrlPolicyConfig {
  /** Hosts (and their subdomains) that may be visited. Empty = any public host. */
  allowedDomains: string[];
  /** Hosts (and their subdomains) that are never reachable. */
  blockedDomains: string[];
  /** Dev/test only. Allows loopback/private targets and any port. */
  allowPrivateNetwork: boolean;
}

export type HostResolver = (host: string) => Promise<string[]>;

const DEFAULT_PORTS = new Set([80, 443, 8080, 8443]);
const MAX_URL_LENGTH = 2048;
const DNS_CACHE_TTL_MS = 30_000;

const defaultResolver: HostResolver = async (host) => {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.$/, '');
}

/** host equals `domain` or is a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith(`.${d}`);
}

/** A run is scoped to the start host (minus a leading "www.") and its subdomains. */
export function scopeHostFor(url: URL): string {
  return normalizeHost(url.hostname).replace(/^www\./, '');
}

export function hostInScope(host: string, scopeHost: string): boolean {
  return hostMatches(host, scopeHost);
}

// ---------------------------------------------------------------------------------------- IP classification

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function parseIPv6(ip: string): bigint | null {
  let addr = ip.split('%')[0] ?? '';
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = parseIPv4(v4[1]!);
    if (n === null) return null;
    addr = `${addr.slice(0, -v4[1]!.length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function ipv4IsPrivate(n: number): boolean {
  const inRange = (base: string, bits: number) => {
    const b = parseIPv4(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local, includes the 169.254.169.254 cloud metadata endpoint
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.0.2.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) ||
    inRange('198.51.100.0', 24) ||
    inRange('203.0.113.0', 24) ||
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved + broadcast
  );
}

/** True for any address that is not a normal public unicast address. Unparseable input counts as private. */
export function isPrivateAddress(rawIp: string): boolean {
  // Playwright reports IPv6 server addresses in brackets: "[2606:4700::1]".
  const ip = rawIp.startsWith('[') && rawIp.endsWith(']') ? rawIp.slice(1, -1) : rawIp;
  const version = net.isIP(ip);
  if (version === 4) {
    const n = parseIPv4(ip);
    return n === null ? true : ipv4IsPrivate(n);
  }
  if (version === 6) {
    const v = parseIPv6(ip);
    if (v === null) return true;
    const top = (bits: number) => v >> BigInt(128 - bits);
    if (v === 0n || v === 1n) return true; // :: and ::1
    if (top(96) === 0xffffn) return ipv4IsPrivate(Number(v & 0xffffffffn)); // ::ffff:a.b.c.d (IPv4-mapped)
    if (top(96) === 0x0064ff9b0000000000000000n) return ipv4IsPrivate(Number(v & 0xffffffffn)); // 64:ff9b::/96 (NAT64)
    if (top(7) === 0b1111110n) return true; // fc00::/7 unique local
    if (top(10) === 0b1111111010n) return true; // fe80::/10 link-local
    if (top(8) === 0xffn) return true; // multicast
    if (top(32) === 0x20010db8n) return true; // documentation
    if (top(16) === 0x2002n || top(32) === 0x20010000n) return true; // 6to4 / Teredo tunnel ranges
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------- policy

export class UrlPolicy {
  private readonly dnsCache = new Map<string, { addresses: string[]; at: number }>();

  constructor(
    private readonly cfg: UrlPolicyConfig,
    private readonly resolver: HostResolver = defaultResolver,
    private readonly now: () => number = Date.now
  ) {}

  get allowPrivateNetwork(): boolean {
    return this.cfg.allowPrivateNetwork;
  }

  /** Parses and validates a URL. Pass `scopeHost` to also require the host to be inside a run's scope. */
  async validate(raw: string, opts: { scopeHost?: string } = {}): Promise<URL> {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
      throw new UrlPolicyError('INVALID_URL', 'The URL is empty or too long.');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UrlPolicyError('INVALID_URL', 'The URL is not valid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UrlPolicyError('UNSUPPORTED_SCHEME', 'Only http and https URLs are allowed.');
    }
    if (url.username || url.password) {
      throw new UrlPolicyError('CREDENTIALS_IN_URL', 'URLs must not contain credentials.');
    }
    const host = normalizeHost(url.hostname);
    if (!host) throw new UrlPolicyError('INVALID_URL', 'The URL has no host.');

    if (this.cfg.blockedDomains.some((d) => hostMatches(host, d))) {
      throw new UrlPolicyError('BLOCKED_HOST', 'This website is blocked.');
    }
    if (this.cfg.allowedDomains.length > 0 && !this.cfg.allowedDomains.some((d) => hostMatches(host, d))) {
      throw new UrlPolicyError('HOST_NOT_ALLOWED', 'This website is not on the allowed list.');
    }
    if (opts.scopeHost && !hostInScope(host, opts.scopeHost)) {
      throw new UrlPolicyError('OUT_OF_SCOPE', 'That page is on a different website than this session.');
    }

    if (!this.cfg.allowPrivateNetwork) {
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      if (!DEFAULT_PORTS.has(port)) {
        throw new UrlPolicyError('BAD_PORT', 'That port is not allowed.');
      }
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new UrlPolicyError('PRIVATE_ADDRESS', 'Local and internal addresses are not allowed.');
      }
      await this.assertPublicHost(host);
    }
    return url;
  }

  /** Every resolved address must be public; a single private record fails the host (DNS-rebinding guard). */
  private async assertPublicHost(host: string): Promise<void> {
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) throw new UrlPolicyError('PRIVATE_ADDRESS', 'Private network addresses are not allowed.');
      return;
    }
    const cached = this.dnsCache.get(host);
    let addresses: string[];
    if (cached && this.now() - cached.at < DNS_CACHE_TTL_MS) {
      addresses = cached.addresses;
    } else {
      try {
        addresses = await this.resolver(host);
      } catch {
        throw new UrlPolicyError('DNS_FAILURE', 'The website address could not be resolved.');
      }
      this.dnsCache.set(host, { addresses, at: this.now() });
      if (this.dnsCache.size > 500) this.dnsCache.clear();
    }
    if (addresses.length === 0) throw new UrlPolicyError('DNS_FAILURE', 'The website address could not be resolved.');
    if (addresses.some(isPrivateAddress)) {
      throw new UrlPolicyError('PRIVATE_ADDRESS', 'That website points at a private network address.');
    }
  }

  /** Post-response check: the connection the browser actually made must not have gone to a private address. */
  assertRemoteAddressPublic(ip: string | undefined): void {
    if (this.cfg.allowPrivateNetwork || !ip) return;
    if (isPrivateAddress(ip)) throw new UrlPolicyError('PRIVATE_ADDRESS', 'The connection went to a private address.');
  }
}
