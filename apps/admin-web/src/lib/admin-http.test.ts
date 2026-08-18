import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * `describeErrorBody` — the one function that decides whether text from the network reaches
 * an operator's screen.
 *
 * It is exercised THROUGH `adminFetch` with real `Response` objects rather than by exporting
 * the parser, because the thing worth asserting is the end-to-end property: what a given HTTP
 * response actually becomes by the time `describeAdminActionError` has rendered it. A test
 * against an exported helper would still pass if the wiring in `adminFetch` changed.
 *
 * The properties under test:
 *  1. A real Nest `AllExceptionsFilter` envelope on a 4xx is shown VERBATIM — that is what
 *     makes the server's own refusals ("Cannot demote the last active super_admin") useful.
 *  2. EVERY other shape degrades to the status-only fallback instead of throwing: an HTML
 *     proxy page, an empty body, a non-string `message`, a body with no `error` at all.
 *  3. `{ "error": "<string>" }` — which this platform's API cannot emit, and which only an
 *     ingress/mesh/gateway produces — is NOT shown, because those bodies carry internal
 *     topology.
 *  4. A 5xx never reaches the rendered string at all.
 *  5. Nothing that IS shown carries the internal origin, an upstream hostname, or a stack.
 */

vi.mock("./auth/session-cookie", () => ({
  readAdminToken: async () => "fake.admin.jwt.value",
}));

// A realistic INTERNAL origin, so "did the base url leak into operator copy" is a real check
// rather than a check against `localhost`.
const INTERNAL_ORIGIN = "http://admin-api.internal.svc.cluster.local:3001";
const previousBaseUrl = process.env.ADMIN_API_BASE_URL;
process.env.ADMIN_API_BASE_URL = INTERNAL_ORIGIN;
afterAll(() => {
  process.env.ADMIN_API_BASE_URL = previousBaseUrl;
});

const { adminFetch, isAdminRequestError, isAdminUnauthorized, isAdminForbidden } =
  await import("./admin-http");
const { describeAdminActionError } = await import("./describe-admin-error");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

/** The exact envelope `AllExceptionsFilter` writes for an `HttpException`. */
function nestEnvelope(status: number, payload: unknown): string {
  return JSON.stringify({
    statusCode: status,
    error: typeof payload === "string" ? { message: payload } : payload,
    requestId: "7f9a2c31-0000-4000-8000-000000000001",
    path: "/admin/admins/a-1/role",
    timestamp: "2026-08-18T09:00:00.000Z",
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

/** Drive one response through `adminFetch` and return the thrown error. */
async function failureFor(body: string | null, init: ResponseInit): Promise<unknown> {
  fetchMock.mockResolvedValueOnce(new Response(body, init));
  try {
    await adminFetch("/admin/admins/a-1/role", { method: "PATCH", body: { role: "analyst" } });
  } catch (err) {
    return err;
  }
  throw new Error("expected adminFetch to reject");
}

/** The string an operator would actually read for this response. */
async function operatorCopyFor(body: string | null, init: ResponseInit): Promise<string> {
  return describeAdminActionError(await failureFor(body, init));
}

// ---------------------------------------------------------------------------
// 1. The six body shapes, table-driven.
// ---------------------------------------------------------------------------

describe("describeErrorBody — body shapes", () => {
  it("the real Nest envelope on a 409 is surfaced verbatim", async () => {
    const err = await failureFor(
      nestEnvelope(409, {
        message: "Cannot demote the last active super_admin",
        error: "Conflict",
        statusCode: 409,
      }),
      { status: 409, headers: JSON_HEADERS },
    );
    expect(isAdminRequestError(err)).toBe(true);
    expect((err as Error).message).toBe("Cannot demote the last active super_admin");
    expect(describeAdminActionError(err)).toBe("Cannot demote the last active super_admin");
  });

  it("a string payload envelope (Nest wraps it as { message }) is surfaced verbatim", async () => {
    // `AllExceptionsFilter` turns a string payload into `{ message: payload }` — this is the
    // shape a bare `throw new NotFoundException("Payer not found")` produces.
    const copy = await operatorCopyFor(nestEnvelope(404, "Payer not found"), {
      status: 404,
      headers: JSON_HEADERS,
    });
    expect(copy).toBe("Payer not found");
  });

  const degradesToFallback: Array<[name: string, body: string | null, status: number]> = [
    [
      "an HTML body (a proxy's 404 page) — must fall back, not throw",
      "<!doctype html><html><head><title>404 Not Found</title></head><body>" +
        "<center><h1>404 Not Found</h1></center><hr><center>nginx/1.25.3 " +
        "(admin-api.internal.svc.cluster.local)</center></body></html>",
      404,
    ],
    ["an empty body", "", 400],
    ["a null body", null, 400],
    ["a body that is not an object at all", '"just a string"', 400],
    [
      "a body where `error.message` is an ARRAY (the Zod pipe's multi-issue shape)",
      JSON.stringify({ statusCode: 400, error: { message: ["a", "b"], statusCode: 400 } }),
      400,
    ],
    [
      "a body where `error.message` is an object",
      JSON.stringify({ error: { message: { detail: "nested" } } }),
      400,
    ],
    [
      "a body where `error.message` is an empty string",
      JSON.stringify({ error: { message: "" } }),
      400,
    ],
    ["a body where `error` is null", JSON.stringify({ error: null }), 409],
    [
      "a body missing `error` entirely",
      JSON.stringify({ statusCode: 400, path: "/admin/admins/a-1/role", detail: "no error key" }),
      400,
    ],
  ];

  it.each(degradesToFallback)("%s degrades to the status-only fallback", async (_n, body, status) => {
    const copy = await operatorCopyFor(body, { status });
    expect(copy).toBe(`The admin API returned ${status}.`);
  });

  it("an HTML proxy page never leaks the upstream hostname it names", async () => {
    const copy = await operatorCopyFor(
      "<html><body>502 — upstream admin-api.internal.svc.cluster.local:3001 refused</body></html>",
      { status: 404, headers: { "content-type": "text/html" } },
    );
    expect(copy).not.toContain("internal.svc.cluster.local");
    expect(copy).not.toContain("nginx");
    expect(copy).toBe("The admin API returned 404.");
  });
});

// ---------------------------------------------------------------------------
// 2. Finding 3 — the intermediary's `{ "error": "<string>" }` shape.
// ---------------------------------------------------------------------------

describe("an intermediary's bare-string `error` is never shown", () => {
  it("an Envoy/mesh 'no healthy upstream' body does NOT reach the operator", async () => {
    // This platform's API cannot produce `{ error: "<string>" }` — `AllExceptionsFilter`
    // always writes an object — so this body is definitionally not the server explaining a
    // refusal, and it is exactly the kind that names internal clusters and pod IPs.
    const body = JSON.stringify({
      error:
        "no healthy upstream for cluster admin-api|10.4.2.19:8080|" +
        "admin-api.internal.svc.cluster.local",
    });
    const copy = await operatorCopyFor(body, { status: 404, headers: JSON_HEADERS });

    expect(copy).toBe("The admin API returned 404.");
    expect(copy).not.toContain("no healthy upstream");
    expect(copy).not.toContain("10.4.2.19");
    expect(copy).not.toContain("internal.svc.cluster.local");
  });

  it("a gateway body naming a hostname on a 400 is dropped too", async () => {
    const copy = await operatorCopyFor(
      JSON.stringify({ error: "connect ECONNREFUSED 10.0.0.7:3001 (admin-api-7d9f)" }),
      { status: 400, headers: JSON_HEADERS },
    );
    expect(copy).toBe("The admin API returned 400.");
    expect(copy).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// 3. Finding 3 — the length cap.
// ---------------------------------------------------------------------------

describe("a verbatim message is capped, not dropped", () => {
  it("truncates a very long refusal to 300 chars with an ellipsis", async () => {
    const long = `Cannot demote the last active super_admin. ${"detail ".repeat(200)}`;
    expect(long.length).toBeGreaterThan(300);

    const copy = await operatorCopyFor(nestEnvelope(409, { message: long }), {
      status: 409,
      headers: JSON_HEADERS,
    });

    expect(copy.length).toBeLessThanOrEqual(300);
    // The useful part — the first sentence — survives; only the tail is cut.
    expect(copy.startsWith("Cannot demote the last active super_admin.")).toBe(true);
    expect(copy.endsWith("…")).toBe(true);
    expect(copy).not.toBe(`The admin API returned 409.`);
  });

  it("leaves a message at exactly the cap untouched", async () => {
    const exact = "x".repeat(300);
    const copy = await operatorCopyFor(nestEnvelope(409, { message: exact }), {
      status: 409,
      headers: JSON_HEADERS,
    });
    expect(copy).toBe(exact);
    expect(copy).not.toContain("…");
  });
});

// ---------------------------------------------------------------------------
// 4. A 5xx never reaches the rendered operator-facing string.
// ---------------------------------------------------------------------------

describe("5xx text never reaches the operator", () => {
  const GENERIC = "The admin API is unreachable or returned an error. Try again.";

  it("a 500 with a Nest envelope collapses to the generic copy", async () => {
    const copy = await operatorCopyFor(nestEnvelope(500, "Internal server error"), {
      status: 500,
      headers: JSON_HEADERS,
    });
    expect(copy).toBe(GENERIC);
    expect(copy).not.toContain("Internal server error");
  });

  it("a 500 whose message carries a stack trace shows none of it", async () => {
    const stack =
      "QueryFailedError: relation \"admin_users\" does not exist\n" +
      "    at PostgresQueryRunner.query (/srv/app/node_modules/typeorm/driver/postgres.js:211:19)\n" +
      "    at AdminActionsService.suspendAdmin (/srv/app/dist/admin/admin-actions.service.js:88:5)";
    const copy = await operatorCopyFor(nestEnvelope(500, { message: stack }), {
      status: 500,
      headers: JSON_HEADERS,
    });
    expect(copy).toBe(GENERIC);
    expect(copy).not.toContain("QueryFailedError");
    expect(copy).not.toContain("at PostgresQueryRunner");
    expect(copy).not.toContain("/srv/app");
  });

  it("a 502 HTML gateway page collapses to the generic copy", async () => {
    const copy = await operatorCopyFor("<html><body>502 Bad Gateway — envoy</body></html>", {
      status: 502,
    });
    expect(copy).toBe(GENERIC);
    expect(copy).not.toContain("envoy");
  });

  it("a transport failure never names the internal origin", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError(`fetch failed: connect ECONNREFUSED ${INTERNAL_ORIGIN}`),
    );
    let thrown: unknown;
    try {
      await adminFetch("/admin/me");
    } catch (err) {
      thrown = err;
    }
    expect(isAdminRequestError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe("The admin API is unreachable.");
    expect(describeAdminActionError(thrown)).toBe(GENERIC);
  });
});

// ---------------------------------------------------------------------------
// 5. Nothing shown ever carries the internal origin, a hostname, or a stack.
// ---------------------------------------------------------------------------

describe("no internal detail survives into operator-facing copy", () => {
  const bodies: Array<[name: string, body: string | null, status: number]> = [
    ["nest 409", nestEnvelope(409, { message: "An admin cannot suspend themselves" }), 409],
    ["mesh string error", JSON.stringify({ error: `no healthy upstream ${INTERNAL_ORIGIN}` }), 404],
    ["html page", `<html>${INTERNAL_ORIGIN}</html>`, 404],
    ["empty", "", 400],
    ["500 envelope", nestEnvelope(500, { message: `boom at ${INTERNAL_ORIGIN}/admin/me` }), 500],
    ["array message", JSON.stringify({ error: { message: [INTERNAL_ORIGIN] } }), 400],
  ];

  it.each(bodies)("%s leaks neither origin, host, ip nor stack frame", async (_n, body, status) => {
    const copy = await operatorCopyFor(body, { status });
    expect(copy).not.toContain(INTERNAL_ORIGIN);
    expect(copy).not.toContain("internal.svc.cluster.local");
    expect(copy).not.toContain("3001");
    expect(copy).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    expect(copy).not.toMatch(/\n\s+at\s/);
    expect(copy).not.toContain("fake.admin.jwt.value");
  });
});

// ---------------------------------------------------------------------------
// 6. The two statuses that never read a body at all.
// ---------------------------------------------------------------------------

describe("401 and 403 short-circuit before the body is read", () => {
  it("a 401 becomes AdminUnauthorizedError regardless of what the body said", async () => {
    const err = await failureFor(nestEnvelope(401, { message: `token dead at ${INTERNAL_ORIGIN}` }), {
      status: 401,
      headers: JSON_HEADERS,
    });
    expect(isAdminUnauthorized(err)).toBe(true);
    expect((err as Error).message).not.toContain(INTERNAL_ORIGIN);
  });

  it("a 403 becomes AdminForbiddenError with its own copy", async () => {
    const err = await failureFor(nestEnvelope(403, { message: "role lacks manage_admins" }), {
      status: 403,
      headers: JSON_HEADERS,
    });
    expect(isAdminForbidden(err)).toBe(true);
    expect(describeAdminActionError(err)).toBe("Your role no longer has permission to do that.");
  });
});

// ---------------------------------------------------------------------------
// 7. The SUCCESS path's two narrowing failures are equally quiet.
// ---------------------------------------------------------------------------

describe("a malformed or unexpected 2xx body is narrowed, never rendered", () => {
  it("a 200 with an unparseable body reports a shape problem, not the body", async () => {
    const { z } = await import("zod");
    fetchMock.mockResolvedValueOnce(new Response("<html>not json</html>", { status: 200 }));
    let thrown: unknown;
    try {
      await adminFetch("/admin/me", { schema: z.object({ admin_id: z.string() }) });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe("The admin API returned a malformed response.");
  });

  it("a 200 that fails the schema never quotes the response values back", async () => {
    const { z } = await import("zod");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ admin_id: 42, phone: "+919876543210" }), {
        status: 200,
        headers: JSON_HEADERS,
      }),
    );
    let thrown: unknown;
    try {
      await adminFetch("/admin/me", { schema: z.object({ admin_id: z.string() }) });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe("The admin API returned an unexpected shape.");
    expect((thrown as Error).message).not.toContain("9876543210");
  });
});
