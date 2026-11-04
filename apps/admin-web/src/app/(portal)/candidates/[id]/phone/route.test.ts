import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RECORD_WORKER_ID } from "../../../../../../test/candidate-record";
import {
  REVEAL_BAD_ID,
  REVEAL_ERRORS,
  REVEAL_FAILED,
  REVEAL_FORBIDDEN,
  REVEAL_NOTE_REFUSED,
  REVEAL_NOT_SAME_ORIGIN,
  REVEAL_NO_REASON,
  REVEAL_REFUSED,
  REVEAL_SIGNED_OUT,
  REVEAL_UNAVAILABLE,
} from "../../reveal-messages";

/**
 * A7 (#2577) — `POST /candidates/<id>/phone`, the drawer's phone reveal: the EXISTING reason-gated
 * `POST /admin/workers/:id/reveal-contact` (ADR-0025 Decision 4), from a same-origin route rather
 * than a server action. What it sends (the closed reason code and the note, never an actor id),
 * what it answers (the phone, nowhere else, never cached), how it fails (ONE neutral sentence for
 * every 404, never the API's text) — and the server action's own checks, made explicitly: a
 * request from anywhere but a page of this portal, a body that is not JSON, and an oversized body
 * are each refused before anything is read or sent.
 */
const http = vi.hoisted(() => {
  class AdminUnauthorizedError extends Error {}
  class AdminForbiddenError extends Error {}
  class AdminRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return { AdminUnauthorizedError, AdminForbiddenError, AdminRequestError, adminFetch: vi.fn() };
});
vi.mock("../../../../../lib/admin-http", () => ({
  adminFetch: http.adminFetch,
  isAdminUnauthorized: (e: unknown) => e instanceof http.AdminUnauthorizedError,
  isAdminForbidden: (e: unknown) => e instanceof http.AdminForbiddenError,
  isAdminRequestError: (e: unknown) => e instanceof http.AdminRequestError,
}));

const route = await import("./route");
const { POST } = route;

const NOTE = "Worker asked us to call back about a job";
const PHONE = "+919800000001";

/** What the drawer's fetch carries: a page of this portal, JSON. */
const DRAWER = {
  host: "admin.test:3003",
  origin: "http://admin.test:3003",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

interface Call {
  headers?: Record<string, string>;
  body?: unknown;
  id?: string;
}

/** POST to the route as Next hands it a request: its own listening address, the browser's headers. */
function post({ headers = DRAWER, body = { reason_code: "worker_support_callback", note: NOTE }, id = RECORD_WORKER_ID }: Call = {}) {
  return POST(
    new Request(`http://0.0.0.0:3003/candidates/${encodeURIComponent(id)}/phone`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** The route's answer: its status, its cache header and its body. */
async function answer(res: Response) {
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() };
}

/** A refusal made before anything was read or sent: this status, this sentence, no-store, no API call. */
async function expectRefusedBeforeTheApi(res: Response, status: number, error: string) {
  expect(await answer(res)).toEqual({ status, cache: "no-store", body: { ok: false, error } });
  expect(http.adminFetch).not.toHaveBeenCalled();
}

beforeEach(() => http.adminFetch.mockReset());

describe("the reveal", () => {
  it("POSTs the closed reason code and the trimmed note to the worker's reveal route — no actor id", async () => {
    http.adminFetch.mockResolvedValue({ worker_id: RECORD_WORKER_ID, phone: PHONE });
    await post({ body: { reason_code: "worker_support_callback", note: `  ${NOTE}  ` } });
    expect(http.adminFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = http.adminFetch.mock.calls[0]!;
    expect(path).toBe(`/admin/workers/${RECORD_WORKER_ID}/reveal-contact`);
    expect(opts).toMatchObject({ method: "POST" });
    expect(opts.body).toEqual({ reason_code: "worker_support_callback", note: NOTE });
    expect(opts.schema).toBeDefined();
    // The admin's token is adminFetch's (the httpOnly cookie, server-side): nothing public, nothing passed.
    expect(opts).not.toHaveProperty("public");
  });

  it("answers the phone with 200, never cached — the only place it exists", async () => {
    http.adminFetch.mockResolvedValue({ worker_id: RECORD_WORKER_ID, phone: PHONE });
    expect(await answer(await post({ body: { reason_code: "dispute_resolution", note: NOTE } }))).toEqual({
      status: 200,
      cache: "no-store",
      body: { ok: true, phone: PHONE },
    });
  });

  it("is rendered per request, and POST is all it answers (any other method is Next's 405)", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
  });
});

describe("nothing is sent for a request that is not the drawer's", () => {
  it.each(["Ramesh Kumar", ".", "..", ""])("a path id that is not a worker id (%j) → 400", async (id) => {
    await expectRefusedBeforeTheApi(await post({ id }), 400, REVEAL_BAD_ID);
  });

  it.each([
    ["a reason outside the closed list", { reason_code: "curiosity", note: NOTE }],
    ["no reason", { note: NOTE }],
  ])("%s → 400, choose a reason", async (_what, body) => {
    await expectRefusedBeforeTheApi(await post({ body }), 400, REVEAL_NO_REASON);
  });

  it.each([
    ["a body that is not JSON", "{reason_code"],
    ["a JSON value that is not an object", JSON.stringify(["worker_support_callback", NOTE])],
    ["no explanation", { reason_code: "worker_support_callback" }],
    ["an explanation that is not text", { reason_code: "worker_support_callback", note: 42 }],
    ["an actor id riding along", { reason_code: "worker_support_callback", note: NOTE, admin_id: "a-1" }],
    ["a worker id riding along", { reason_code: "worker_support_callback", note: NOTE, worker_id: RECORD_WORKER_ID }],
  ])("%s → 400, refused", async (_what, body) => {
    await expectRefusedBeforeTheApi(await post({ body }), 400, REVEAL_REFUSED);
  });

  it("a body over the bound → 413, refused as the explanation, the part an operator writes", async () => {
    const body = { reason_code: "worker_support_callback", note: "x".repeat(5000) };
    await expectRefusedBeforeTheApi(await post({ body }), 413, REVEAL_NOTE_REFUSED);
  });

  it("an explanation over the API's 280 but within the bound is the API's to refuse", async () => {
    http.adminFetch.mockRejectedValueOnce(
      new http.AdminRequestError(400, "Validation failed", { issues: [{ path: "note" }] }),
    );
    const res = await post({ body: { reason_code: "worker_support_callback", note: "x".repeat(600) } });
    expect(http.adminFetch).toHaveBeenCalledTimes(1);
    expect(await answer(res)).toEqual({ status: 400, cache: "no-store", body: { ok: false, error: REVEAL_NOTE_REFUSED } });
  });
});

/**
 * The checks a server action gets from Next, made here — each refused before anything is read or
 * sent. `lib/same-origin-request.test.ts` holds every case of each rule; these hold the wiring.
 */
describe("a request from anywhere but a page of this portal is refused before anything is read", () => {
  it.each(["cross-site", "same-site", "none"])("Sec-Fetch-Site: %s → 403", async (site) => {
    const res = await post({ headers: { ...DRAWER, "sec-fetch-site": site } });
    await expectRefusedBeforeTheApi(res, 403, REVEAL_NOT_SAME_ORIGIN);
  });

  it.each(["https://evil.example", "http://other.admin.test:3003", "http://admin.test:4000", "null"])(
    "Origin: %s → 403",
    async (origin) => {
      await expectRefusedBeforeTheApi(await post({ headers: { ...DRAWER, origin } }), 403, REVEAL_NOT_SAME_ORIGIN);
    },
  );

  it("an X-Forwarded-Host naming the foreign Origin is not believed → 403", async () => {
    // The request's own scheme (post() is http), so only the host tells the forged Origin apart.
    const headers = {
      ...DRAWER,
      origin: "http://evil.example",
      "x-forwarded-host": "evil.example",
    };
    await expectRefusedBeforeTheApi(await post({ headers }), 403, REVEAL_NOT_SAME_ORIGIN);
  });

  it("an older browser that sends neither Sec-Fetch-Site nor Origin is let through to the API", async () => {
    http.adminFetch.mockResolvedValue({ worker_id: RECORD_WORKER_ID, phone: PHONE });
    const res = await post({ headers: { host: "admin.test:3003", "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(http.adminFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
    "a body declared %s — all a cross-origin form can send — → 415",
    async (type) => {
      const res = await post({ headers: { ...DRAWER, "content-type": type } });
      await expectRefusedBeforeTheApi(res, 415, REVEAL_REFUSED);
    },
  );

  /**
   * The case the JSON rule ALONE holds, which is why it must not be loosened while an absent header
   * is allowed. A page on another localhost port is the same SITE, so its request carries the
   * SameSite=strict session; an older browser sends no Sec-Fetch-Site, and older Firefox no Origin
   * on a form POST; and a `text/plain` form can post a body that parses as the drawer's JSON.
   */
  it("an older browser's text/plain form from a same-site page — session attached, no Sec-Fetch-Site, no Origin — → 415", async () => {
    const form = '{"reason_code":"worker_support_callback","note":"="}\r\n';
    const headers = { host: "admin.test:3003", "content-type": "text/plain" };
    await expectRefusedBeforeTheApi(await post({ headers, body: form }), 415, REVEAL_REFUSED);
  });

  it("JSON with a charset is JSON", async () => {
    http.adminFetch.mockResolvedValue({ worker_id: RECORD_WORKER_ID, phone: PHONE });
    const res = await post({ headers: { ...DRAWER, "content-type": "application/json; charset=utf-8" } });
    expect(res.status).toBe(200);
  });
});

describe("a refused reveal", () => {
  it("EVERY 404 is the same one sentence — off, over the cap, unknown worker: the server does not say", async () => {
    for (const message of ["Not found", "reveal disabled", "cap exceeded"]) {
      http.adminFetch.mockRejectedValueOnce(new http.AdminRequestError(404, message));
      expect(await answer(await post())).toEqual({
        status: 404,
        cache: "no-store",
        body: { ok: false, error: REVEAL_UNAVAILABLE },
      });
    }
  });

  it("a 400 naming the note says how to fix the note; any other 400 says the request was refused", async () => {
    http.adminFetch.mockRejectedValueOnce(
      new http.AdminRequestError(400, "Validation failed", {
        message: "Validation failed",
        issues: [{ path: "note", message: "note must not contain a phone number" }],
      }),
    );
    expect((await answer(await post())).body).toEqual({ ok: false, error: REVEAL_NOTE_REFUSED });
    http.adminFetch.mockRejectedValueOnce(
      new http.AdminRequestError(400, "Validation failed", { issues: [{ path: "reason_code" }] }),
    );
    expect(await answer(await post())).toEqual({
      status: 400,
      cache: "no-store",
      body: { ok: false, error: REVEAL_REFUSED },
    });
  });

  it.each([
    ["a role without reveal_pii (403)", () => new http.AdminForbiddenError(), 403, REVEAL_FORBIDDEN],
    ["a session that ended (401)", () => new http.AdminUnauthorizedError(), 401, REVEAL_SIGNED_OUT],
    ["a fault on our side (5xx)", () => new http.AdminRequestError(503, "upstream detail"), 502, REVEAL_FAILED],
    ["an unreachable API", () => new http.AdminRequestError(0, "unreachable"), 502, REVEAL_FAILED],
    ["an unexpected answer", () => new TypeError("boom"), 502, REVEAL_FAILED],
  ])("%s", async (_what, err, status, error) => {
    http.adminFetch.mockRejectedValueOnce(err());
    expect(await answer(await post())).toEqual({ status, cache: "no-store", body: { ok: false, error } });
  });

  it("never echoes the API's own text back to the screen", async () => {
    http.adminFetch.mockRejectedValueOnce(new http.AdminRequestError(404, "worker 0b7f has no phone"));
    const res = await post();
    expect(JSON.stringify(await res.json())).not.toContain("0b7f has no phone");
  });

  /**
   * The drawer shows a refusal only when it is one of `REVEAL_ERRORS` (anything else reads as
   * REVEAL_FAILED). So every sentence this route can answer with must be in it — read off the
   * route's own source, so a sentence added there without joining the set fails here.
   */
  it("every sentence the route answers with is one the drawer shows — static copy only", async () => {
    const messages: Record<string, unknown> = await import("../../reveal-messages");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    const used = new Set(source.match(/\bREVEAL_[A-Z_]+\b/g));
    expect(used.size).toBeGreaterThanOrEqual(9);
    for (const name of used) {
      expect(typeof messages[name], name).toBe("string");
      expect(REVEAL_ERRORS.has(messages[name] as string), name).toBe(true);
    }
  });
});
