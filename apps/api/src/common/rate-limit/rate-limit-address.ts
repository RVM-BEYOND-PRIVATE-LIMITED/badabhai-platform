import { isIP } from "node:net";

/**
 * The address a per-IP rate limit counts against (#2542).
 *
 * WHY IPv6 IS GROUPED BY /64. One subscriber is normally handed a whole /64, and can pick any of its
 * 2^64 addresses per request. Keying on the full address would give that one subscriber 2^64 free
 * buckets the moment per-visitor addressing is live (`TRUST_PROXY_HOP_COUNT=1`) and an AAAA record
 * points at the box. Grouping by the /64 keeps it one bucket, the same as an IPv4 home connection.
 *
 * An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`, how a dual-stack socket reports an IPv4 peer)
 * counts as the IPv4 address it carries. IPv4, and anything that is not an IP at all (`"unknown"`),
 * is returned unchanged, so live IPv4 buckets keep counting across the deploy that adds this.
 *
 * PRIVACY: this only decides what gets hashed; the caller HMACs the result before it reaches a
 * Redis key, and nothing here is logged.
 */
export function rateLimitAddress(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (isIP(value) !== 6) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1] !== undefined) return mapped[1];
  const groups = expandIpv6(value);
  if (groups === null) return ip;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address `isIP` accepted, lower-case hex without leading 0s. */
function expandIpv6(address: string): string[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  // An embedded IPv4 tail (`64:ff9b::192.0.2.1`) is two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}
