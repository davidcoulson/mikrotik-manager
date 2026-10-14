import { isIPv4, isIPv6 } from 'net';

/** Expand an IPv6 literal (any valid textual form) to eight 16-bit groups. */
function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!isIPv6(s)) return null;
  // dotted-quad tail → two hex groups
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const o = tail.split('.').map(Number);
    s = s.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address an IPv6 literal carries, if any: IPv4-mapped (::ffff:a.b.c.d,
 * also in the hex form ::ffff:7f00:1 that URL parsing produces), the deprecated
 * IPv4-compatible ::a.b.c.d, and NAT64 (64:ff9b::/96). Null otherwise.
 */
export function embeddedIPv4(ip: string): string | null {
  const g = expandIPv6(ip);
  if (!g) return null;
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  const zeros5 = g.slice(0, 5).every((x) => x === 0);
  if (zeros5 && g[5] === 0xffff) return v4;                       // ::ffff:0:0/96 mapped
  if (zeros5 && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) return v4; // ::/96 compatible (not :: or ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4; // NAT64
  return null;
}
