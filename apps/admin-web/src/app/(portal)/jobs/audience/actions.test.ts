import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2958 — where a job shows, and the trades RVM trains (#2957), as the admin console sends them.
 *
 * Every decision goes through the bulk route (one shape for one job and many). For ONE job a
 * refusal is a failure in plain words; for a batch the summary is a success and each job carries
 * its own outcome. A 404 is the switch being off. Nothing invalid reaches the network.
 */
const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message = "boom") {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: (e: unknown) => e instanceof FakeRequestError && e.status === 401,
  isAdminForbidden: (e: unknown) => e instanceof FakeRequestError && e.status === 403,
}));

const { decideAudienceAction, setCampusTradesAction } = await import("./actions");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REASON = { category: "other", text: "Three openings, RVM students fit well" };
const result = (posting_id: string, outcome: string, shown_to: string | null = "campus") => ({
  posting_id,
  outcome,
  shown_to,
});

beforeEach(() => adminFetch.mockReset());

describe("decideAudienceAction", () => {
  it("one job, Campus only: POSTs the bulk route with the reason, and says Saved", async () => {
    adminFetch.mockResolvedValueOnce({ results: [result(A, "changed")] });
    const out = await decideAudienceAction({
      postingIds: [A],
      audience: "rvm_students",
      reason: REASON,
    });
    expect(out).toMatchObject({ ok: true, changed: true, message: "Saved." });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/postings/audience",
      expect.objectContaining({
        method: "POST",
        body: {
          posting_ids: [A],
          audience: "rvm_students",
          reason_code: "other",
          reason_text: REASON.text,
        },
      }),
    );
  });

  it("one job refused (a painter job to Campus): a failure that says why", async () => {
    adminFetch.mockResolvedValueOnce({
      results: [result(A, "trade_not_taught_at_campus", "badabhai")],
    });
    const out = await decideAudienceAction({ postingIds: [A], audience: "both", reason: REASON });
    expect(out).toEqual({
      ok: false,
      error: "RVM doesn't train this trade, so this job can only show on BadaBhai.",
    });
  });

  it("a batch: a summary, and each job's own outcome", async () => {
    adminFetch.mockResolvedValueOnce({
      results: [result(A, "changed"), result(B, "trade_required", "nobody")],
    });
    const out = await decideAudienceAction({
      postingIds: [A, B],
      audience: "rvm_students",
      reason: REASON,
    });
    expect(out).toMatchObject({
      ok: true,
      changed: true,
      message: "1 changed, 0 already set, 1 refused.",
    });
    expect(out.ok && out.results?.map((r) => r.outcome)).toEqual(["changed", "trade_required"]);
  });

  it("the switch off (404): says so", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404));
    const out = await decideAudienceAction({ postingIds: [A], audience: "both", reason: REASON });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("not switched on yet");
  });

  it("nothing invalid reaches the network: a short reason, an unknown audience, no jobs", async () => {
    for (const bad of [
      { postingIds: [A], audience: "both", reason: { category: "other", text: "short" } },
      { postingIds: [A], audience: "campus", reason: REASON },
      { postingIds: [], audience: "both", reason: REASON },
    ]) {
      expect((await decideAudienceAction(bad)).ok).toBe(false);
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("setCampusTradesAction", () => {
  it("PUTs the whole list with the reason and reports what moved", async () => {
    adminFetch.mockResolvedValueOnce({ trades: [], added: ["cnc_turner"], removed: [] });
    const out = await setCampusTradesAction({ tradeKeys: ["cnc_turner"], reason: REASON });
    expect(out).toEqual({ ok: true, changed: true, message: "Saved. Added 1, removed 0." });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/campus-trades",
      expect.objectContaining({
        method: "PUT",
        body: { trade_keys: ["cnc_turner"], reason_code: "other", reason_text: REASON.text },
      }),
    );
  });

  it("the same list again: nothing changed", async () => {
    adminFetch.mockResolvedValueOnce({ trades: [], added: [], removed: [] });
    expect(await setCampusTradesAction({ tradeKeys: [], reason: REASON })).toMatchObject({
      ok: true,
      changed: false,
    });
  });
});
