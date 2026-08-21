import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Company/Agency governed-action Server Actions (`suspend_payer`, `grant_credits`).
 *
 * Mirrors `login/actions.test.ts`'s mocking shape: `adminFetch` is mocked at the module
 * boundary, so these assert what each action SENDS and how it maps a response — not the real
 * network/cookie machinery, which is `admin-http.ts`'s own concern.
 *
 * Three properties carry real weight here:
 *  1. **`changed: false` is success, never an error** (Step 3 of the write-action plan).
 *  2. **The idempotency key is forwarded exactly as given** — this action never mints or
 *     mutates it; that is the caller's (`PayerCreditsPanel`'s) job, one key per grant,
 *     rotated only once the server confirms it (see `lib/credit-grant-outcome.ts`).
 *  3. **An out-of-range amount is rejected client-side before any network call**, matching
 *     the server's own `AdminGrantCreditsSchema` bound.
 */

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { suspendPayerAction, reinstatePayerAction, grantCreditsAction } = await import(
  "./payer-actions"
);

beforeEach(() => {
  adminFetch.mockReset();
});

describe("suspendPayerAction", () => {
  it("POSTs to the suspend route and reports a real change", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "p-1", changed: true });
    const res = await suspendPayerAction("p-1");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/payers/p-1/suspend",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res).toEqual({
      ok: true,
      changed: true,
      message: "Payer suspended. Their postings are hidden and their sessions revoked.",
    });
  });

  it("an idempotent no-op (already suspended) is SUCCESS, not an error", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "p-1", changed: false });
    const res = await suspendPayerAction("p-1");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
  });

  it("surfaces the server's own conflict text on a 409", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "Payer status changed concurrently; retry"),
    );
    const res = await suspendPayerAction("p-1");
    expect(res).toEqual({ ok: false, error: "Payer status changed concurrently; retry" });
  });

  it("a 404 (unknown payer) surfaces the server's own text", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "Payer not found"));
    const res = await suspendPayerAction("nonexistent");
    expect(res).toEqual({ ok: false, error: "Payer not found" });
  });
});

describe("reinstatePayerAction", () => {
  it("POSTs to the reinstate route", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "p-1", changed: true });
    await reinstatePayerAction("p-1");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/payers/p-1/reinstate",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("grantCreditsAction", () => {
  const validInput = {
    amount: 500,
    reasonCode: "goodwill" as const,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  };

  it("forwards the amount, reason and idempotency key EXACTLY, snake_cased for the wire", async () => {
    adminFetch.mockResolvedValueOnce({
      target_id: "p-1",
      changed: true,
      ledger_id: "l-1",
      balance: 1500,
    });
    await grantCreditsAction("p-1", validInput);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/payers/p-1/credits",
      expect.objectContaining({
        method: "POST",
        body: {
          amount: 500,
          reason_code: "goodwill",
          idempotency_key: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );
  });

  it("reports the new balance on a real grant", async () => {
    adminFetch.mockResolvedValueOnce({
      target_id: "p-1",
      changed: true,
      ledger_id: "l-1",
      balance: 1500,
    });
    const res = await grantCreditsAction("p-1", validInput);
    expect(res).toEqual({
      ok: true,
      changed: true,
      message: "Granted 500 credits. New balance: 1500.",
    });
  });

  it("a replayed idempotency key is a SUCCESSFUL no-op, not a double grant", async () => {
    adminFetch.mockResolvedValueOnce({
      target_id: "p-1",
      changed: false,
      ledger_id: "l-1",
      balance: 1500,
    });
    const res = await grantCreditsAction("p-1", validInput);
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an amount over the cap WITHOUT calling the API", async () => {
    const res = await grantCreditsAction("p-1", { ...validInput, amount: 10_001 });
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-integer amount without calling the API", async () => {
    const res = await grantCreditsAction("p-1", { ...validInput, amount: 5.5 });
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed idempotency key without calling the API", async () => {
    const res = await grantCreditsAction("p-1", { ...validInput, idempotencyKey: "not-a-uuid" });
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("surfaces the server's suspended-payer conflict verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "Payer is suspended; credits cannot be granted"),
    );
    const res = await grantCreditsAction("p-1", validInput);
    expect(res).toEqual({ ok: false, error: "Payer is suspended; credits cannot be granted" });
  });
});
