import { describe, expect, it } from "vitest";
import { isJsonRequest, isSameOriginRequest, readBodyText } from "./same-origin-request";

/**
 * A7 review (#2577) — the checks a same-origin route that reveals or changes something makes,
 * because Next makes them only for a server action: the browser's own fetch metadata, the Origin
 * against the address the browser sent the request to (never X-Forwarded-Host), a JSON body, and
 * a bounded read of it.
 */

/** As Next hands a route handler a request: its own listening address, the browser's headers. */
const at = (headers: Record<string, string>, url = "http://0.0.0.0:3003/candidates/x/phone") =>
  new Request(url, { method: "POST", headers, body: "{}" });

const PORTAL = { host: "admin.test:3003" };

describe("Sec-Fetch-Site — set by the browser, never by a page", () => {
  it("same-origin is a page of this portal", () => {
    expect(isSameOriginRequest(at({ ...PORTAL, "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it.each(["cross-site", "same-site", "none", "", "SAME-ORIGIN"])("%j is refused", (site) => {
    expect(isSameOriginRequest(at({ ...PORTAL, "sec-fetch-site": site }))).toBe(false);
  });

  it("absent (an older browser) is not refused — SameSite=strict, JSON-only and Origin cover it", () => {
    expect(isSameOriginRequest(at(PORTAL))).toBe(true);
  });
});

describe("Origin — must be the portal's own, as the browser addressed it", () => {
  it("the scheme of the request and its Host: the drawer's own page", () => {
    expect(isSameOriginRequest(at({ ...PORTAL, origin: "http://admin.test:3003" }))).toBe(true);
  });

  it("read the way a browser writes it: Host's letter case and a default port do not differ", () => {
    expect(isSameOriginRequest(at({ host: "Admin.TEST:3003", origin: "http://admin.test:3003" }))).toBe(true);
    expect(isSameOriginRequest(at({ host: "admin.test:80", origin: "http://admin.test" }))).toBe(true);
    expect(
      isSameOriginRequest(
        at({ host: "admin.test", origin: "https://admin.test" }, "https://0.0.0.0:3003/candidates/x/phone"),
      ),
    ).toBe(true);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["a sibling host", "http://other.admin.test:3003"],
    ["the same host on another port", "http://admin.test:4000"],
    ["the same host and port on another scheme", "https://admin.test:3003"],
    ["a sandboxed frame or a file (null)", "null"],
    ["not an origin at all", "admin.test:3003"],
    ["an origin with a path, which no browser sends", "http://admin.test:3003/candidates"],
  ])("%s (%j) is refused", (_what, origin) => {
    expect(isSameOriginRequest(at({ ...PORTAL, "sec-fetch-site": "same-origin", origin }))).toBe(false);
  });

  it("X-Forwarded-Host is never trusted: a forged one naming the foreign Origin changes nothing", () => {
    expect(
      isSameOriginRequest(
        at({ ...PORTAL, origin: "https://evil.example", "x-forwarded-host": "evil.example" }),
      ),
    ).toBe(false);
  });

  it("nor is it needed: Next defaults it from Host, and the portal's own Origin still passes beside it", () => {
    expect(
      isSameOriginRequest(
        at({ ...PORTAL, origin: "http://admin.test:3003", "x-forwarded-host": "admin.test:3003" }),
      ),
    ).toBe(true);
  });

  it.each([
    ["no Host to compare it with", {}],
    ["an empty Host", { host: "" }],
    ["a Host carrying credentials", { host: "evil@admin.test:3003" }],
    ["a Host carrying a path", { host: "admin.test:3003/x" }],
  ])("an Origin with %s is refused — it cannot be confirmed", (_what, host) => {
    expect(isSameOriginRequest(at({ ...host, origin: "http://admin.test:3003" }))).toBe(false);
  });

  it("absent (some browsers send none on a same-origin POST) is not refused", () => {
    expect(isSameOriginRequest(at({ ...PORTAL, "sec-fetch-site": "same-origin" }))).toBe(true);
  });
});

describe("isJsonRequest — no other site can send JSON here", () => {
  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])(
    "%j is JSON",
    (type) => {
      expect(isJsonRequest(at({ "content-type": type }))).toBe(true);
    },
  );

  it.each([
    "text/plain",
    "text/plain;charset=UTF-8",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "application/jsonp",
    "",
  ])("%j — what a cross-site form or a simple request can send — is not", (type) => {
    expect(isJsonRequest(at({ "content-type": type }))).toBe(false);
  });

  it("no declared type is not JSON", () => {
    expect(isJsonRequest(new Request("http://admin.test/", { method: "POST" }))).toBe(false);
  });
});

describe("readBodyText — bounded", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  /** A body that arrives in these chunks, recording whether the reader gave up on it. */
  const streamed = (chunks: Uint8Array[]) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://admin.test/", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    return { request, cancelled: () => cancelled };
  };

  it("reads a body within the bound, a character whose bytes are split across chunks included", async () => {
    const rupee = bytes("₹"); // three bytes
    const { request } = streamed([
      bytes('{"note":"Paid '),
      rupee.slice(0, 2),
      new Uint8Array([...rupee.slice(2), ...bytes('500"}')]),
    ]);
    expect(await readBodyText(request, 64)).toBe('{"note":"Paid ₹500"}');
  });

  it("reads exactly the bound", async () => {
    expect(await readBodyText(new Request("http://a/", { method: "POST", body: "x".repeat(16) }), 16)).toBe(
      "x".repeat(16),
    );
  });

  it("stops at the first chunk past it — null, and the rest is never read", async () => {
    const { request, cancelled } = streamed([bytes("x".repeat(10)), bytes("x".repeat(10)), bytes("x".repeat(10))]);
    expect(await readBodyText(request, 15)).toBeNull();
    expect(cancelled()).toBe(true);
  });

  it("counts bytes, not characters", async () => {
    // Five rupee signs are 5 characters and 15 bytes.
    expect(await readBodyText(new Request("http://a/", { method: "POST", body: "₹₹₹₹₹" }), 14)).toBeNull();
  });

  it("no body is the empty string", async () => {
    expect(await readBodyText(new Request("http://a/", { method: "POST" }), 16)).toBe("");
  });
});
