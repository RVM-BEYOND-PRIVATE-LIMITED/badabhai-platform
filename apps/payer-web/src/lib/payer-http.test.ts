import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * THE TRANSPORT'S TYPED STATUS. A non-2xx used to be a bare `Error("payer API <path> returned
 * <status>")`, and ~30 seam checks matched that message with a regex (`/returned 404/`, `endsWith("
 * returned 429")`). It is now a {@link PayerHttpError} carrying `status` and `path`, read through
 * ONE helper (`httpStatusOf` / `isPayerStatus`):
 *  - the message is byte-for-byte the old one, so anything still reading it is unchanged;
 *  - the 400 / 409 subclasses ARE PayerHttpErrors (400 / 409), and a price mismatch deliberately
 *    is NOT (a seam must never read it as a bare 409);
 *  - an `Error` built OUTSIDE the transport in exactly its message shape (a test's fake transport,
 *    another module instance) still reads as that status — and nothing looser does;
 *  - a 409 carries the API's machine-readable `reason` (#2135) when the body names one, else null.
 *
 * The transport is the real one; only `fetch` and the httpOnly cookie reader are stubbed.
 */
vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => "payer.jwt.token"),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const { payerFetch } = await import("./payer-http");
const {
  PayerConflictError,
  PayerHttpError,
  PayerValidationError,
  PriceMismatchError,
  httpStatusOf,
  isPayerBadRequest,
  isPayerRateLimited,
  isPayerStatus,
} = await import("./payer-errors");

beforeEach(() => {
  vi.stubEnv("PAYER_API_URL", "http://api.test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
/** What the transport throws for this response (it must throw). */
async function thrownFor(res: Response, path = "/payer/x"): Promise<unknown> {
  fetchMock.mockResolvedValueOnce(res);
  return payerFetch(path, { schema: z.unknown() }).then(
    () => {
      throw new Error("expected the transport to throw");
    },
    (e: unknown) => e,
  );
}
/** A 409 exactly as the API's exception filter nests a thrown ConflictException payload. */
function conflict(payload: Record<string, unknown>): Response {
  return json(
    {
      statusCode: 409,
      error: { statusCode: 409, error: "Conflict", ...payload },
      requestId: "req-1",
      path: "/payer/credits",
      timestamp: "2026-10-07T09:00:00.000Z",
    },
    409,
  );
}

describe("a non-2xx is a PayerHttpError with its status TYPED — and the historic message", () => {
  it.each([403, 404, 429, 500, 502, 503])("%i", async (status) => {
    const e = await thrownFor(json({ message: "deny reason the payer must never see" }, status));
    expect(e).toBeInstanceOf(PayerHttpError);
    expect(e).toBeInstanceOf(Error);
    const err = e as InstanceType<typeof PayerHttpError>;
    expect(err.status).toBe(status);
    expect(err.path).toBe("/payer/x");
    expect(err.name).toBe("PayerHttpError");
    // Byte-for-byte the message every caller used to match — and no body text in it.
    expect(err.message).toBe(`payer API /payer/x returned ${status}`);
    expect(httpStatusOf(e)).toBe(status);
    expect(isPayerStatus(e, status)).toBe(true);
  });

  it("the path is kept as sent — query and all", async () => {
    const e = await thrownFor(json({}, 404), "/payer/reach/applicants?cursor=abc");
    expect((e as InstanceType<typeof PayerHttpError>).path).toBe(
      "/payer/reach/applicants?cursor=abc",
    );
    expect((e as Error).message).toBe("payer API /payer/reach/applicants?cursor=abc returned 404");
  });

  it("a 400 with field issues is a PayerValidationError — a PayerHttpError 400", async () => {
    const e = await thrownFor(
      json({ error: { issues: [{ path: "role_title", message: "Too short" }] } }, 400),
    );
    expect(e).toBeInstanceOf(PayerValidationError);
    expect(e).toBeInstanceOf(PayerHttpError);
    expect((e as InstanceType<typeof PayerValidationError>).issues).toEqual([
      { path: "role_title", message: "Too short" },
    ]);
    expect((e as Error).name).toBe("PayerValidationError");
    expect((e as Error).message).toBe("payer API /payer/x returned 400");
    expect(httpStatusOf(e)).toBe(400);
    expect(isPayerBadRequest(e)).toBe(true);
  });

  it("a 400 with no readable issues is a plain PayerHttpError 400 — a bad request all the same", async () => {
    const e = await thrownFor(json({ message: "nope" }, 400));
    expect(e).not.toBeInstanceOf(PayerValidationError);
    expect(httpStatusOf(e)).toBe(400);
    expect(isPayerBadRequest(e)).toBe(true);
  });

  it("a 429 is rate limited, read from the status", async () => {
    const e = await thrownFor(json({}, 429));
    expect(isPayerRateLimited(e)).toBe(true);
    expect(isPayerBadRequest(e)).toBe(false);
  });
});

describe("a 409 is a PayerConflictError carrying the API's reason (#2135) when it names one", () => {
  it("reason: 'in_flight' (the nested envelope) → reason + detail, status 409", async () => {
    const e = await thrownFor(
      conflict({ reason: "in_flight", message: "This purchase is already being processed" }),
    );
    expect(e).toBeInstanceOf(PayerConflictError);
    const err = e as InstanceType<typeof PayerConflictError>;
    expect(err.reason).toBe("in_flight");
    expect(err.detail).toBe("This purchase is already being processed");
    expect(err.status).toBe(409);
    expect(err.message).toBe("payer API /payer/x returned 409");
  });

  it("a flat body is read too", async () => {
    const e = await thrownFor(json({ reason: "no_active_plan", message: "no plan" }, 409));
    expect((e as InstanceType<typeof PayerConflictError>).reason).toBe("no_active_plan");
  });

  it("an API before #2135 names no reason → null (and an empty or non-string one is no reason)", async () => {
    for (const body of [
      conflict({ message: "This purchase is already being processed" }),
      conflict({ reason: "", message: "x" }),
      conflict({ reason: 7, message: "x" }),
      json("not an object", 409),
    ]) {
      const e = await thrownFor(body);
      expect(e).toBeInstanceOf(PayerConflictError);
      expect((e as InstanceType<typeof PayerConflictError>).reason).toBeNull();
      expect(httpStatusOf(e)).toBe(409);
    }
  });

  it("a price_mismatch is NOT a PayerHttpError: no status is read from it, never a bare 409", async () => {
    const e = await thrownFor(conflict({ reason: "price_mismatch", current_price_inr: 1800 }));
    expect(e).toBeInstanceOf(PriceMismatchError);
    expect(e).not.toBeInstanceOf(PayerHttpError);
    expect(httpStatusOf(e)).toBeNull();
    expect(isPayerStatus(e, 409)).toBe(false);
  });
});

describe("httpStatusOf — an error made OUTSIDE the transport, in exactly its message shape", () => {
  it("reads the status of a plain Error in the transport's shape (a test's fake transport)", () => {
    expect(httpStatusOf(new Error("payer API /payer/x returned 404"))).toBe(404);
    expect(httpStatusOf(new Error("payer API x returned 409"))).toBe(409);
    expect(isPayerRateLimited(new Error("payer API /payer/agency/workers returned 429"))).toBe(
      true,
    );
    expect(
      isPayerBadRequest(new Error("payer API /payer/reach/applicants?cursor=abc returned 400")),
    ).toBe(true);
  });

  it("reads the LAST status, and only a 3-digit one at the very end", () => {
    expect(httpStatusOf(new Error("payer API /x returned 400 returned 500"))).toBe(500);
    expect(httpStatusOf(new Error("payer API /payer/reach/applicants returned 4000"))).toBeNull();
    expect(httpStatusOf(new Error("payer API /x returned 404 (cached)"))).toBeNull();
  });

  it("reads nothing from anything else", () => {
    for (const e of [
      new Error("http://api.test/payer/capacity returned 500"), // a network-layer message
      new Error("returned 404"),
      new Error("payer session expired or missing"),
      new PriceMismatchError("/payer/credits", 1800),
      "payer API /x returned 404", // not an Error
      { status: 404, message: "payer API /x returned 404" }, // a look-alike object
      null,
      undefined,
    ]) {
      expect(httpStatusOf(e), String(e)).toBeNull();
    }
  });

  it("a typed error is read by its status, whatever its message says", () => {
    const e = new PayerHttpError("/payer/x", 404);
    Object.defineProperty(e, "message", { value: "rewritten" });
    expect(httpStatusOf(e)).toBe(404);
  });
});
