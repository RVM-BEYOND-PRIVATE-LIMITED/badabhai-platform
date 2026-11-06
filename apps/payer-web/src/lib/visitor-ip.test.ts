import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE VISITOR IP (#2542) — what payer-web may send the API as `X-Forwarded-For`.
 *
 * Pinned: only the LAST entry of the incoming header is read (nginx appends the real peer; any
 * earlier entry may be forged); only a plain PUBLIC unicast address is sent, canonicalised; every
 * other value — and no request scope, or a failing read — sends nothing, without throwing.
 */

const headersImpl = vi.fn<() => Promise<Headers>>();
vi.mock("next/headers", () => ({ headers: () => headersImpl() }));

const { visitorIpFrom, visitorIpHeaders, VISITOR_IP_HEADER } = await import("./visitor-ip");

beforeEach(() => {
  headersImpl.mockReset();
});

describe("visitorIpFrom — the last entry, public unicast only", () => {
  it("the LAST entry wins (the one nginx appended), trimmed", () => {
    expect(visitorIpFrom("6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
    expect(visitorIpFrom("6.6.6.6,203.0.113.7")).toBe("203.0.113.7");
    expect(visitorIpFrom(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(visitorIpFrom("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
  });

  it("a non-public LAST entry sends nothing — never an earlier (forgeable) one", () => {
    expect(visitorIpFrom("203.0.113.7, 10.0.0.5")).toBeNull();
    expect(visitorIpFrom("203.0.113.7, unknown")).toBeNull();
    expect(visitorIpFrom("203.0.113.7, ")).toBeNull();
  });

  it.each([
    // missing / empty
    [null],
    [undefined],
    [""],
    // loopback, private, CGNAT, link-local, ULA (the brief's list)
    ["127.0.0.1"],
    ["::1"],
    ["10.1.2.3"],
    ["172.18.0.1"],
    ["100.64.0.1"],
    ["fe80::1"],
    ["fe80::1%eth0"],
    ["fc00::1"],
    // not a plain address
    ["1.2.3.4:80"],
    ["[::1]"],
    ["[2001:db8::1]:443"],
    ["unknown"],
    ["2001:db8::1%eth0"], // a PUBLIC address with a zone id: isIP() alone would accept it
    // every other rejected range
    ["0.0.0.0"],
    ["0.1.2.3"],
    ["169.254.169.254"],
    ["192.168.1.1"],
    ["172.31.255.255"],
    ["100.127.255.255"],
    ["224.0.0.1"],
    ["239.255.255.250"],
    ["240.0.0.1"],
    ["255.255.255.255"],
    ["::"],
    ["fd12:3456::1"],
    ["febf::1"],
    ["ff02::1"],
    // a mapped private address, and the mapped forms that are not canonicalised (fail closed)
    ["::ffff:10.0.0.1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:cb00:7107"],
    ["0:0:0:0:0:ffff:203.0.113.7"],
  ])("%j sends nothing", (value) => {
    expect(visitorIpFrom(value)).toBeNull();
  });

  it("a 46-character value sends nothing", () => {
    const long = `${"1".repeat(34)}.203.0.113.7`;
    expect(long).toHaveLength(46);
    expect(visitorIpFrom(long)).toBeNull();
    expect(visitorIpFrom(`6.6.6.6, ${long}`)).toBeNull();
  });

  it("the edges of each private range stay public", () => {
    const edges = ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0"];
    edges.push("100.63.255.255", "100.128.0.0", "169.253.255.255", "223.255.255.255", "fbff::1");
    for (const ip of edges) expect(visitorIpFrom(ip), ip).toBe(ip);
  });

  it("canonicalises: a dotted IPv4-mapped address becomes IPv4; IPv6 is lowercased", () => {
    expect(visitorIpFrom("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(visitorIpFrom("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(visitorIpFrom("2606:4700:4700::AbCd")).toBe("2606:4700:4700::abcd");
  });

  it("documentation ranges are ACCEPTED (nginx never sees one as a peer): 2001:db8::/32 is sent lowercased", () => {
    expect(visitorIpFrom("2001:DB8::1")).toBe("2001:db8::1");
    expect(visitorIpFrom("198.51.100.20")).toBe("198.51.100.20");
  });
});

describe("visitorIpHeaders — ONE plain header, or none; never throws", () => {
  it("sends the last public entry as x-forwarded-for", async () => {
    headersImpl.mockResolvedValue(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }));
    expect(VISITOR_IP_HEADER).toBe("x-forwarded-for");
    await expect(visitorIpHeaders()).resolves.toStrictEqual({ "x-forwarded-for": "203.0.113.7" });
  });

  it("a missing header sends nothing — x-real-ip and forwarded are never read", async () => {
    headersImpl.mockResolvedValue(
      new Headers({ "x-real-ip": "203.0.113.7", forwarded: "for=203.0.113.7" }),
    );
    await expect(visitorIpHeaders()).resolves.toStrictEqual({});
  });

  it("a local-dev socket address (Next's own fill, no nginx) sends nothing", async () => {
    for (const local of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      headersImpl.mockResolvedValueOnce(new Headers({ "x-forwarded-for": local }));
      await expect(visitorIpHeaders(), local).resolves.toStrictEqual({});
    }
  });

  it("no request scope / a failing read sends nothing, without throwing", async () => {
    headersImpl.mockImplementationOnce(() => {
      throw new Error("`headers` was called outside a request scope.");
    });
    await expect(visitorIpHeaders()).resolves.toStrictEqual({});
    headersImpl.mockRejectedValueOnce(new Error("boom"));
    await expect(visitorIpHeaders()).resolves.toStrictEqual({});
  });
});
