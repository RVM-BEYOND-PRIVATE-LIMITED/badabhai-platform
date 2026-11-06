import "server-only";
import { BlockList, isIP } from "node:net";
import { headers } from "next/headers";

/**
 * THE VISITOR'S IP, for the API's per-IP rate limits (#2542) — SERVER-ONLY.
 *
 * payer-web calls the API server-to-server, so without this the API sees payer-web's own
 * container address for every payer and each per-IP cap (sign-in / OTP, invite clicks) is one
 * global bucket. The API trusts exactly ONE proxy hop (`TRUST_PROXY_HOP_COUNT=1`: the rightmost
 * `X-Forwarded-For` entry from whoever connects to it directly — this app), so each server-side
 * call carries ONE plain `X-Forwarded-For: <visitor ip>`. Not a secret, not an identity: a
 * rate-limit key only. With the API at hop 0 it is ignored.
 *
 * WHICH ENTRY. Browsers reach this app only through the box nginx, which APPENDS the address it
 * saw (`$proxy_add_x_forwarded_for`), so the LAST entry of the incoming header is the real
 * visitor and anything before it may be forged by the client. Only that last entry is read.
 *
 * WHAT IS SENT. Only a PUBLIC unicast address in plain form (see {@link visitorIpFrom}). A
 * loopback / private / link-local value — local dev without nginx, where Next fills the header
 * with the socket address — sends nothing, so the API falls back to the connection address as
 * it does today. The incoming chain, `x-real-ip` and `forwarded` are NEVER forwarded.
 */

/** The ONE header this app sets on a server-side API call. */
export const VISITOR_IP_HEADER = "x-forwarded-for";

/** The longest textual IP accepted (a full IPv6 with an embedded IPv4 is 45). */
const MAX_IP_LENGTH = 45;

/** `::ffff:a.b.c.d` — the dotted IPv4-mapped form, canonicalised to `a.b.c.d`. */
const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/** Every range that is NOT a public unicast visitor address. */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
  list.addSubnet("10.0.0.0", 8, "ipv4"); // private
  list.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
  list.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  list.addSubnet("169.254.0.0", 16, "ipv4"); // link-local
  list.addSubnet("172.16.0.0", 12, "ipv4"); // private (the docker bridge lives here)
  list.addSubnet("192.168.0.0", 16, "ipv4"); // private
  list.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  list.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
  list.addAddress("::", "ipv6"); // unspecified
  list.addAddress("::1", "ipv6"); // loopback
  list.addSubnet("fc00::", 7, "ipv6"); // ULA
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  return list;
})();

/**
 * IPv4-mapped IPv6 in any spelling. Checked for IPv6 ONLY, after the dotted form is canonicalised:
 * a hex or expanded mapped spelling is refused (fail closed) rather than sent in a form the API
 * may bucket apart from the plain IPv4. Its own list because BlockList also matches a plain IPv4
 * against a mapped rule — in NOT_PUBLIC it would refuse every IPv4.
 */
const MAPPED = (() => {
  const list = new BlockList();
  list.addSubnet("::ffff:0:0", 96, "ipv6");
  return list;
})();

/**
 * The visitor IP an incoming `X-Forwarded-For` value names, or null. PURE.
 *
 * The LAST comma-separated entry, trimmed, accepted only when it is at most 45 chars, has no
 * zone (`%`), port or brackets, is a valid IPv4/IPv6 address and — once canonicalised (dotted
 * IPv4-mapped → IPv4, IPv6 lowercased) — is public unicast. Documentation ranges (192.0.2/24,
 * 198.51.100/24, 203.0.113/24, 2001:db8::/32) are ACCEPTED: nginx can never see one as a real
 * peer, so refusing them would protect nothing.
 */
export function visitorIpFrom(forwardedFor: string | null | undefined): string | null {
  if (!forwardedFor) return null;
  const last = forwardedFor.split(",").pop()?.trim() ?? "";
  if (last.length === 0 || last.length > MAX_IP_LENGTH) return null;
  // isIP() ACCEPTS a zone id ("fe80::1%eth0"), so `%` is refused here. Brackets and an IPv4 port
  // already fail isIP(); refused here too as a plain pre-filter.
  if (/[%[\]]/.test(last)) return null;
  let ip = last;
  let family = isIP(ip);
  if (family === 6) {
    ip = ip.toLowerCase();
    const mapped = MAPPED_DOTTED.exec(ip)?.[1];
    if (mapped !== undefined && isIP(mapped) === 4) {
      ip = mapped;
      family = 4;
    }
  }
  if (family === 4) return NOT_PUBLIC.check(ip, "ipv4") ? null : ip;
  if (family !== 6 || MAPPED.check(ip, "ipv6")) return null;
  return NOT_PUBLIC.check(ip, "ipv6") ? null : ip;
}

/**
 * The headers to add to ONE server-side API call: `{ "x-forwarded-for": <ip> }`, or `{}` when
 * there is no request scope (a script, a test), the read fails, or the value is not a public IP.
 * Never throws — the API call proceeds either way. (Swallowing a static-render bailout is safe:
 * every seam call is a `no-store` fetch, which opts its route into dynamic rendering anyway.)
 */
export async function visitorIpHeaders(): Promise<Record<string, string>> {
  let incoming: string | null;
  try {
    incoming = (await headers()).get(VISITOR_IP_HEADER);
  } catch {
    return {};
  }
  const ip = visitorIpFrom(incoming);
  return ip ? { [VISITOR_IP_HEADER]: ip } : {};
}
