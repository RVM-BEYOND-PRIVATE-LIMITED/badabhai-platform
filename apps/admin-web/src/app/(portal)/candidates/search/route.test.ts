import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A7 (#2577) — `POST /candidates/search`, the universal search box's same-origin read: the
 * term rides the POST body only (never a URL — access logs record those), and the route
 * answers slim dropdown rows plus the exact total, never cached, refused before any read for
 * a request from another site or a body that is not JSON.
 *
 * Like the phone reveal's route test, the admin transport's errors are LOCAL fakes: the
 * predicates are mocked to read them, so the test proves the mapping (signed out → 401,
 * forbidden → 403, the API's own text never echoed) without importing the real transport.
 */
const fakeTransport = vi.hoisted(() => {
  class AdminUnauthorizedError extends Error {}
  class AdminForbiddenError extends Error {}
  class AdminRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { AdminUnauthorizedError, AdminForbiddenError, AdminRequestError };
});
vi.mock("../../../../lib/admin-http", () => ({
  isAdminUnauthorized: (e: unknown) => e instanceof fakeTransport.AdminUnauthorizedError,
  isAdminForbidden: (e: unknown) => e instanceof fakeTransport.AdminForbiddenError,
  isAdminRequestError: (e: unknown) => e instanceof fakeTransport.AdminRequestError,
}));
const search = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/candidate-search-server", () => ({ searchCandidates: search }));

const { POST, dynamic } = await import("./route");

const ROW = {
  worker_id: "5eeded00-0001-4a00-8000-000000000001",
  name: "Ramesh Kumar",
  status: "active",
  flagged: false,
  is_test_account: false,
  deletion_scheduled_at: null,
  current_city: "Pune",
  current_state: "Maharashtra",
  trade_label: "Welder",
  role_label: "TIG Welder",
  domain_label: "Fabrication",
  total_experience_years: "4",
  role_experience_months: 30,
  availability_status: "within_a_month",
  shift_preference: "day",
  form_level: "medium",
  skills: ["skill_welding"],
  languages: ["hi"],
  education_level: "10th pass",
  resume_count: 2,
  latest_resume_status: "rendered",
  profile_status: "confirmed",
  last_active_at: "2026-11-01T09:00:00.000Z",
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  ai_cost_inr: "12.480000",
  referral_source: null,
};

const call = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://admin.test/candidates/search", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => search.mockReset());

describe("the universal search read", () => {
  it("posts the term in the body and answers slim rows with the exact total", async () => {
    search.mockResolvedValue({ candidates: [ROW], total: 24310, total_pages: 3039, q_type: "name" });
    const res = await call({ q: "welder", filters: { city: ["Pune"] } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(search).toHaveBeenCalledWith({
      q: "welder",
      filters: { city: ["Pune"] },
      sort: "last_active_at",
      dir: "desc",
      page: 1,
      page_size: 25,
    });
    expect(await res.json()).toEqual({
      status: "ok",
      total: 24310,
      q_type: "name",
      candidates: [
        {
          worker_id: ROW.worker_id,
          name: "Ramesh Kumar",
          status: "active",
          current_city: "Pune",
          current_state: "Maharashtra",
          trade_label: "Welder",
          profile_status: "confirmed",
        },
      ],
    });
  });

  it("asks for the API's smallest page and answers at most eight rows", async () => {
    search.mockResolvedValue({ candidates: [ROW], total: 24310, total_pages: 973, q_type: "name" });
    await call({ q: "welder", page: 99 });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ page: 99, page_size: 25 }),
    );
  });

  it("omits the name key when the read disclosed none (faceless stays faceless)", async () => {
    const { name: _dropped, ...faceless } = ROW;
    search.mockResolvedValue({ candidates: [faceless], total: 1, total_pages: 1, q_type: null });
    const res = await call({ q: "welder" });
    const [only] = (await res.json()).candidates as Array<Record<string, unknown>>;
    expect(Object.hasOwn(only!, "name")).toBe(false);
  });

  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("a refused request never reaches the API", () => {
  it.each(["cross-site", "same-site"])("Sec-Fetch-Site: %s → 403", async (site) => {
    const res = await call({ q: "welder" }, { "sec-fetch-site": site });
    expect(res.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("a non-JSON body → 415", async () => {
    const res = await POST(
      new Request("http://admin.test/candidates/search", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain" },
        body: "welder",
      }),
    );
    expect(res.status).toBe(415);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([{ q: "" }, { q: "   " }, {}, { q: "x".repeat(201) }, { q: "welder", sort: "nope" }])(
    "an invalid body (%j) → 400",
    async (body) => {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(search).not.toHaveBeenCalled();
    },
  );

  it("unparseable JSON → 400", async () => {
    const res = await call("{oops");
    expect(res.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
});

describe("a failed search is the box's bare status — never the API's text", () => {
  it("a signed-out session → 401", async () => {
    search.mockRejectedValueOnce(new fakeTransport.AdminUnauthorizedError("gone"));
    const res = await call({ q: "welder" });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "signed_out" });
  });

  it("a session without the capability → 403", async () => {
    search.mockRejectedValueOnce(new fakeTransport.AdminForbiddenError("no"));
    const res = await call({ q: "welder" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: "forbidden" });
  });

  it.each([400, 404])("a %i from the API → 404 not_found (the box is no oracle)", async (code) => {
    search.mockRejectedValueOnce(new fakeTransport.AdminRequestError(code, "no such thing"));
    const res = await call({ q: "welder" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: "not_found" });
  });

  it("anything else → 502", async () => {
    search.mockRejectedValueOnce(new fakeTransport.AdminRequestError(500, "boom"));
    const res = await call({ q: "welder" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "error" });
  });
});
