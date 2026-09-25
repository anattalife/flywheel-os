import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for loopback, private, link-local, carrier-grade NAT, unique-local and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9')
      || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
  }
  return true;
}

/**
 * For addresses a business typed in (not the operator): HTTPS only, and the host
 * must resolve to public addresses, so the server can't be pointed at itself or
 * the cloud metadata service.
 */
export async function assertPublicHttps(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('That address is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new Error('The address must start with https://');
  if (url.username || url.password) throw new Error('Put credentials in the API key field, not the address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('That address is not public.');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) throw new Error('That address could not be found.');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That address is not public.');
  return url;
}
