import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCandidateQuery } from "../../../../lib/candidate-search-model";

/**
 * A7 (#2577) — the browser's `POST /candidates/search` route. The term stays in the BODY all
 * the way to the API (ADR-0062 §3.6); a cross-site or non-JSON request is refused before any
 * search cap is spent.
 */
const search = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/candidate-search", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, searchCandidates: search };
});

const { POST } = await import("./route");

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://admin.test/candidates/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: "http://admin.test",
      host: "admin.test",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const emptyPage = {
  candidates: [],
  page: 1,
  page_size: 50,
  total: 0,
  total_pages: 0,
  counts: { by_status: [], by_trade: [], by_city: [], by_profile_status: [] },
  q_type: null,
};

beforeEach(() => search.mockReset());

describe("the search route", () => {
  it("forwards the body to the API and returns the page, never cached", async () => {
    search.mockResolvedValue(emptyPage);
    const res = await POST(
      req({
        q: "Ramesh",
        filters: { city: ["Pune"] },
        sort: "last_active_at",
        dir: "desc",
        page: 1,
        page_size: 50,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, data: emptyPage });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ q: "Ramesh", filters: { city: ["Pune"] } }),
      expect.any(AbortSignal),
    );
  });

  it("refuses cross-site and non-JSON requests before searching", async () => {
    expect((await POST(req({}, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(
      (
        await POST(
          new Request("http://admin.test/candidates/search", {
            method: "POST",
            headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(415);
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts the filters a view link carries (the query model's own shape)", async () => {
    search.mockResolvedValue(emptyPage);
    const query = parseCandidateQuery("?status=active&city=Pune&page=2&page_size=25");
    const res = await POST(req(query));
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith(query, expect.any(AbortSignal));
  });
});
