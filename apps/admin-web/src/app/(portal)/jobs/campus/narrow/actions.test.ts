import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3050 — the Campus narrow read and write. The POST carries the chosen trade, its optional rung
 * and a reason of at least 15 characters; only `changed` means the row leaves the queue. Every
 * other outcome is the queue's own copy, and an invalid body never reaches the network.
 */
const adminFetch = vi.hoisted(() => vi.fn());
const getJobPosting = vi.hoisted(() => vi.fn());

class FakeRequestError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, message = "boom", body?: Record<string, unknown>) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.body = body;
  }
}

vi.mock("../../../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

vi.mock("../../../../../lib/entities", () => ({
  getJobPosting: (...a: unknown[]) => getJobPosting(...a),
}));

const { narrowTradeAction, readNarrowDescriptionAction } = await import("./actions");

const BODY = {
  posting_id: "0b9e6a3f-0000-4000-8000-000000000001",
  role_kind: "cnc_turner" as const,
  trade_level: "operator",
  reason_code: "incorrect_details" as const,
  reason_text: "Narrowing an old Campus job to its machine trade from the description.",
};

beforeEach(() => {
  adminFetch.mockReset();
  getJobPosting.mockReset();
});

describe("narrowTradeAction", () => {
  it("POSTs the trade, rung and reason, and reports a changed row", async () => {
    adminFetch.mockResolvedValueOnce({
      posting_id: BODY.posting_id,
      outcome: "changed",
      role_kind: "cnc_turner",
      match_skill_ids: ["mskill_cnc_turner"],
    });

    const result = await narrowTradeAction(BODY);

    const [path, opts] = adminFetch.mock.calls[0]! as [
      string,
      { method: string; body: Record<string, unknown> },
    ];
    expect(path).toBe(`/admin/postings/${BODY.posting_id}/narrow-trade`);
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({
      role_kind: "cnc_turner",
      trade_level: "operator",
      reason_code: "incorrect_details",
      reason_text: BODY.reason_text,
    });
    expect(result).toMatchObject({ ok: true, result: { outcome: "changed" } });
  });

  it("omits trade_level when no rung is chosen", async () => {
    adminFetch.mockResolvedValueOnce({
      posting_id: BODY.posting_id,
      outcome: "changed",
      role_kind: "cnc_turner",
      match_skill_ids: ["mskill_cnc_turner"],
    });
    await narrowTradeAction({ ...BODY, trade_level: undefined });
    const [, opts] = adminFetch.mock.calls[0]! as [string, { body: Record<string, unknown> }];
    expect(opts.body).not.toHaveProperty("trade_level");
  });

  it("keeps the row in the queue when the trade is not released, with its own copy", async () => {
    adminFetch.mockResolvedValueOnce({
      posting_id: BODY.posting_id,
      outcome: "trade_not_released",
      role_kind: "injection_moulding_operator",
      match_skill_ids: ["mskill_cnc_operator_general"],
    });
    const result = await narrowTradeAction(BODY);
    expect(result).toEqual({
      ok: false,
      error: "That trade is not switched on yet, so the job was left as it is.",
    });
  });

  it("shows the queue's copy for a job that is no longer narrowable", async () => {
    adminFetch.mockResolvedValueOnce({
      posting_id: BODY.posting_id,
      outcome: "not_narrowable",
      role_kind: "cnc_operator_general",
      match_skill_ids: ["mskill_cnc_operator_general"],
    });
    const result = await narrowTradeAction(BODY);
    expect(result).toEqual({
      ok: false,
      error: "This job is not waiting to be narrowed any more.",
    });
  });

  it("refuses a short reason before it reaches the network", async () => {
    const result = await narrowTradeAction({ ...BODY, reason_text: "too short" });
    expect(result).toMatchObject({ ok: false });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("shows the server's own words for a 4xx refusal", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(403, "Not allowed"));
    const result = await narrowTradeAction(BODY);
    expect(result).toEqual({ ok: false, error: "Not allowed" });
  });

  it("hides a 5xx behind the safe action copy", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "upstream leaked topology"));
    const result = await narrowTradeAction(BODY);
    expect(result.ok).toBe(false);
    expect(result).not.toMatchObject({ error: "upstream leaked topology" });
  });
});

describe("readNarrowDescriptionAction", () => {
  it("reads the one posting the dialog is about", async () => {
    getJobPosting.mockResolvedValueOnce({ description: "Runs a lathe." });
    await expect(readNarrowDescriptionAction(BODY.posting_id)).resolves.toEqual({
      ok: true,
      description: "Runs a lathe.",
    });
    expect(getJobPosting).toHaveBeenCalledWith(BODY.posting_id);
  });

  it("reports a failed read without blanking the queue", async () => {
    getJobPosting.mockRejectedValueOnce(new FakeRequestError(404, "No such posting."));
    await expect(readNarrowDescriptionAction(BODY.posting_id)).resolves.toEqual({
      ok: false,
      error: "No such posting.",
    });
  });
});
