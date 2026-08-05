import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createJobPosting, updateJobPosting, closeJobPosting } from "./api";

/**
 * Wire-level tests for the ops job-posting WRITES (ADR-0012). These three calls are
 * behind the API's `InternalServiceGuard` as of commit 922af4d1, so the assertion that
 * matters is that each one attaches `x-internal-service-token` — which only holds when
 * the call runs on the server. `client-server-boundary.test.ts` pins the other half:
 * that no `"use client"` module can reach these functions.
 *
 * The publicConfig default API base is `http://localhost:3001`.
 */

const API = "http://localhost:3001";
const TOKEN = "test-internal-token";
const POSTING = "22222222-2222-4222-8222-222222222222";

interface FetchInit {
  method?: string;
  cache?: string;
  body?: string;
  headers: Record<string, string>;
}

let fetchMock: ReturnType<typeof vi.fn>;

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

/** A non-2xx response carrying a NestJS-shaped error body. */
function errJson(status: number, message: unknown) {
  return {
    ok: false,
    status,
    statusText: "Unprocessable Entity",
    json: async () => ({ message }),
  } as unknown as Response;
}

function firstCall(): [string, FetchInit] {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("fetch was never called");
  return call as unknown as [string, FetchInit];
}

const ROW = { id: POSTING, status: "draft" };

beforeEach(() => {
  process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

describe("createJobPosting", () => {
  it("POSTs /job-postings with the internal token and the JSON body", async () => {
    fetchMock.mockResolvedValue(okJson(ROW));
    await createJobPosting({
      created_by: "00000000-0000-4000-8000-000000000001",
      org_label: "Acme",
      role_title: "CNC Operator",
      vacancy_band: "1",
    });

    const [url, init] = firstCall();
    expect(url).toBe(`${API}/job-postings`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-internal-service-token"]).toBe(TOKEN);
  });
});

describe("updateJobPosting", () => {
  it("PATCHes /job-postings/:id with the internal token", async () => {
    fetchMock.mockResolvedValue(okJson(ROW));
    await updateJobPosting(POSTING, { status: "open" });

    const [url, init] = firstCall();
    expect(url).toBe(`${API}/job-postings/${POSTING}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers["x-internal-service-token"]).toBe(TOKEN);
    expect(init.body).toBe(JSON.stringify({ status: "open" }));
  });
});

describe("closeJobPosting", () => {
  it("POSTs /job-postings/:id/close with the internal token and no body", async () => {
    fetchMock.mockResolvedValue(okJson({ ...ROW, status: "closed" }));
    await closeJobPosting(POSTING);

    const [url, init] = firstCall();
    expect(url).toBe(`${API}/job-postings/${POSTING}/close`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers["content-type"]).toBeUndefined();
    expect(init.headers["x-internal-service-token"]).toBe(TOKEN);
  });
});

describe("no token in the environment", () => {
  it("omits the header entirely so the API guard fails CLOSED", async () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    fetchMock.mockResolvedValue(okJson(ROW));
    await closeJobPosting(POSTING);

    const [, init] = firstCall();
    expect(init.headers["x-internal-service-token"]).toBeUndefined();
  });
});

describe("server error messages reach the caller verbatim", () => {
  it("surfaces the 422 description-PII reject message, not a status line", async () => {
    fetchMock.mockResolvedValue(errJson(422, "remove contact details from the description"));
    await expect(
      createJobPosting({
        created_by: "00000000-0000-4000-8000-000000000001",
        org_label: "Acme",
        role_title: "CNC Operator",
        vacancy_band: "1",
      }),
    ).rejects.toThrow("remove contact details from the description");
  });

  it("joins a Zod array message", async () => {
    fetchMock.mockResolvedValue(errJson(400, ["org_label is required", "role_title is required"]));
    await expect(updateJobPosting(POSTING, { org_label: "" })).rejects.toThrow(
      "org_label is required; role_title is required",
    );
  });
});
