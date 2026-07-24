import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listPendingAgencyKyc, verifyAgencyKyc, rejectAgencyKyc } from "./api";

/**
 * Wire-level tests for the agency-KYC ops calls (ADR-0022 Amendment 2): assert each
 * function POSTs/GETs the CORRECT path + payload and attaches the shared internal
 * service token server-side. The publicConfig default API base is
 * `http://localhost:3001`.
 */

const API = "http://localhost:3001";
const TOKEN = "test-internal-token";
const PAYER = "11111111-1111-4111-8111-111111111111";

/** The shape of the `fetch(url, init)` call our api helpers make. */
interface FetchInit {
  method?: string;
  cache?: string;
  body?: string;
  headers: Record<string, string>;
}

let fetchMock: ReturnType<typeof vi.fn>;

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

/** The first (and only) recorded fetch call, typed for assertions. */
function firstCall(): [string, FetchInit] {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("fetch was never called");
  return call as unknown as [string, FetchInit];
}

beforeEach(() => {
  process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

describe("listPendingAgencyKyc", () => {
  it("GETs the masked pending queue with the internal token, no-store", async () => {
    fetchMock.mockResolvedValue(okJson([]));
    await listPendingAgencyKyc();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall();
    expect(url).toBe(`${API}/ops/agency-kyc/pending`);
    expect(init.cache).toBe("no-store");
    expect(init.headers["x-internal-service-token"]).toBe(TOKEN);
  });
});

describe("verifyAgencyKyc", () => {
  it("POSTs the verify path with no body and the internal token", async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
    const res = await verifyAgencyKyc(PAYER);

    expect(res).toEqual({ ok: true });
    const [url, init] = firstCall();
    expect(url).toBe(`${API}/ops/agency-kyc/${PAYER}/verify`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers["x-internal-service-token"]).toBe(TOKEN);
    // No body ⇒ no content-type header is attached.
    expect(init.headers["content-type"]).toBeUndefined();
  });
});

describe("rejectAgencyKyc", () => {
  it("POSTs the reject path with the bounded reason as the JSON body", async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
    const res = await rejectAgencyKyc(PAYER, "invalid_pan");

    expect(res).toEqual({ ok: true });
    const [url, init] = firstCall();
    expect(url).toBe(`${API}/ops/agency-kyc/${PAYER}/reject`);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-internal-service-token"]).toBe(TOKEN);
    expect(init.body).toBe(JSON.stringify({ reason: "invalid_pan" }));
  });

  it("passes a no-op result ({ ok: false }) straight through", async () => {
    fetchMock.mockResolvedValue(okJson({ ok: false }));
    const res = await rejectAgencyKyc(PAYER, "duplicate");
    expect(res).toEqual({ ok: false });
  });
});
