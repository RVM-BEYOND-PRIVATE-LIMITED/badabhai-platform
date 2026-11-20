import { beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message = "refused") {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../../../lib/admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (err: unknown) => err instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { createPayOnJoiningHireAction, updatePayOnJoiningHireAction } = await import(
  "./actions"
);

const FACTORY = "11111111-1111-4111-8111-111111111111";
const WORKER = "33333333-3333-4333-8333-333333333333";
const PARTNER = "22222222-2222-4222-8222-222222222222";
const POSTING = "44444444-4444-4444-8444-444444444444";
const HIRE = "55555555-5555-4555-8555-555555555555";

const input = (over: Record<string, unknown> = {}) => ({
  factoryPayerId: FACTORY,
  workerId: WORKER,
  jobPostingId: POSTING,
  partnerPayerId: PARTNER,
  joinedOn: "2026-11-01",
  stayCheckedOn: "2026-12-01",
  stayed30Days: true,
  feeRupees: "5000",
  invoicedOn: "2026-11-02",
  factoryPaidOn: "2026-11-03",
  partnerPaidOn: "2026-11-04",
  note: "Recorded from the pilot call.",
  ...over,
});

beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockResolvedValue({ hire: { id: HIRE }, changed: true });
});

const bodyOf = (call: unknown[]) => (call[1] as { body: Record<string, unknown> }).body;

describe("createPayOnJoiningHireAction", () => {
  it("converts the rupee fee to integer paise and sends only accepted fields", async () => {
    const result = await createPayOnJoiningHireAction(input());
    expect(result.ok).toBe(true);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/pay-on-joining-hires",
      expect.objectContaining({ method: "POST" }),
    );
    const body = bodyOf(adminFetch.mock.calls[0]!);
    expect(body).toMatchObject({
      factory_payer_id: FACTORY,
      worker_id: WORKER,
      job_posting_id: POSTING,
      partner_payer_id: PARTNER,
      joined_on: "2026-11-01",
      stay_checked_on: "2026-12-01",
      stayed_30_days: true,
      fee_paise: 500000,
      invoiced_on: "2026-11-02",
      factory_paid_on: "2026-11-03",
      partner_paid_on: "2026-11-04",
      note: "Recorded from the pilot call.",
    });
    for (const owned of [
      "partner_share_percent",
      "partner_share_paise",
      "payment_state",
      "created_by_admin_id",
      "updated_by_admin_id",
    ]) {
      expect(body, owned).not.toHaveProperty(owned);
    }
  });

  it("records a 409 as the hire already being recorded", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(409, "conflict"));
    const result = await createPayOnJoiningHireAction(input());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/already recorded/i);
  });

  it("names the switch when the route 404s", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "Not Found"));
    const result = await createPayOnJoiningHireAction(input());
    expect(result).toEqual({
      ok: false,
      error: "Pay-on-joining records are not switched on yet.",
    });
  });

  it("refuses a 30-day date without its outcome, before any request", async () => {
    const result = await createPayOnJoiningHireAction(
      input({ stayed30Days: null, stayCheckedOn: "2026-12-01" }),
    );
    expect(result.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("refuses a partner payment without a partner, and a partner that is the factory", async () => {
    expect(
      (await createPayOnJoiningHireAction(input({ partnerPayerId: "" }))).ok,
    ).toBe(false);
    expect(
      (await createPayOnJoiningHireAction(input({ partnerPayerId: FACTORY }))).ok,
    ).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("clears empty optional fields as null, not as empty strings", async () => {
    await createPayOnJoiningHireAction(
      input({
        jobPostingId: "",
        partnerPayerId: "",
        stayCheckedOn: "",
        stayed30Days: null,
        invoicedOn: "",
        factoryPaidOn: "",
        partnerPaidOn: "",
        note: "",
      }),
    );
    const body = bodyOf(adminFetch.mock.calls[0]!);
    expect(body.job_posting_id).toBeNull();
    expect(body.partner_payer_id).toBeNull();
    expect(body.stay_checked_on).toBeNull();
    expect(body.stayed_30_days).toBeNull();
    expect(body.note).toBeNull();
  });
});

describe("updatePayOnJoiningHireAction", () => {
  it("PATCHes the same accepted body, with the fee converted to paise", async () => {
    await updatePayOnJoiningHireAction(HIRE, input({ feeRupees: "5900.50" }));
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/pay-on-joining-hires/${HIRE}`,
      expect.objectContaining({ method: "PATCH" }),
    );
    const body = bodyOf(adminFetch.mock.calls[0]!);
    expect(body.fee_paise).toBe(590050);
    expect(body).not.toHaveProperty("partner_share_percent");
    expect(body).not.toHaveProperty("partner_share_paise");
    expect(body).not.toHaveProperty("payment_state");
    expect(body).not.toHaveProperty("created_by_admin_id");
    expect(body).not.toHaveProperty("updated_by_admin_id");
  });

  it("refuses an invalid id before any request", async () => {
    const result = await updatePayOnJoiningHireAction("nope", input());
    expect(result.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("reports a no-op edit as a successful no-change", async () => {
    adminFetch.mockResolvedValueOnce({ hire: { id: HIRE }, changed: false });
    const result = await updatePayOnJoiningHireAction(HIRE, input());
    expect(result).toMatchObject({ ok: true, changed: false });
  });
});
