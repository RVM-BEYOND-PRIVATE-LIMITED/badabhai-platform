import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class RequestError extends Error {
    status: number;
    body?: Record<string, unknown>;
    constructor(status: number, body?: Record<string, unknown>) {
      super("server text that must never reach the operator");
      this.name = "AdminRequestError";
      this.status = status;
      this.body = body;
    }
  }
  class Unauthorized extends Error {}
  class Forbidden extends Error {}
  return { RequestError, Unauthorized, Forbidden };
});

vi.mock("./admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof h.RequestError,
  isAdminUnauthorized: (err: unknown) => err instanceof h.Unauthorized,
  isAdminForbidden: (err: unknown) => err instanceof h.Forbidden,
}));

const { describeNumbersActionError } = await import("./numbers-errors");
const { SERVICE_UNAVAILABLE, NOT_ALLOWED } = await import("./admin-action-messages");

describe("numbers action copy", () => {
  it.each([
    ["campus_company", "Campus"],
    ["portal_import", "portal import ledger"],
    ["factory_already_recorded", "already recorded"],
    ["share_limit_exceeded", "at most five"],
    ["payer_not_found", "does not exist"],
    ["link_created_without_ref", "needs a payment link"],
    ["paid_at_mismatch", "exactly when the result is paid"],
    ["payment_order_without_payer", "needs the factory's company account"],
    ["payment_order_needs_paid_result", "only after the factory has paid"],
    ["payment_order_not_found", "No such payment order"],
    ["payment_order_not_real", "not a real payment order"],
    ["payment_order_not_paid", "not paid"],
    ["payment_order_other_payer", "different company account"],
    ["payment_order_already_linked", "already links"],
    ["idempotency_key_reused", "already used"],
  ])("turns %s into operator copy", (reason, needle) => {
    expect(describeNumbersActionError(new h.RequestError(409, { reason }))).toContain(needle);
  });

  it("names each refused worker and its own reason", () => {
    const copy = describeNumbersActionError(
      new h.RequestError(400, {
        reason: "workers_not_eligible",
        workers: [
          { worker_id: "w-1", reason: "not_found" },
          { worker_id: "w-2", reason: "linked_rvm_identity" },
        ],
      }),
    );
    expect(copy).toContain("w-1 — no such worker");
    expect(copy).toContain("w-2 — a linked RVM student");
  });

  it("maps a switch-off 404 and a missing migration 503", () => {
    expect(describeNumbersActionError(new h.RequestError(404))).toBe("Not switched on yet.");
    expect(describeNumbersActionError(new h.RequestError(503))).toBe("Try again later.");
  });

  it("never renders the server's own text", () => {
    const copy = describeNumbersActionError(new h.RequestError(500));
    expect(copy).toBe(SERVICE_UNAVAILABLE);
    expect(copy).not.toContain("server text");
    expect(describeNumbersActionError(new h.Forbidden())).toBe(NOT_ALLOWED);
  });
});
