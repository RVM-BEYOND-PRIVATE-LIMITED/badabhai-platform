import { beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();

vi.mock("../../../lib/admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));
vi.mock("../../../lib/numbers-errors", () => ({
  describeNumbersActionError: (err: unknown) =>
    err instanceof Error ? err.message : "unexpected failure",
}));

const {
  logCreditCallAction,
  markTestCompanyAction,
  recordLaunchFactoryAction,
  unmarkTestCompanyAction,
  updateLaunchFactoryAction,
} = await import("./actions");

const PAYER = "8a110000-0001-4a00-8000-000000000001";
const FACTORY = "0d110000-0001-4a00-8000-000000000001";
const WORKER = "1e110000-0001-4a00-8000-000000000001";
const KEY = "call-01HZX9K4Y6";

beforeEach(() => {
  adminFetch.mockReset();
});

describe("test-company writes", () => {
  it("mark sends the closed reason and the Idempotency-Key", async () => {
    adminFetch.mockResolvedValueOnce({ payer_id: PAYER, is_test_account: true, changed: true });
    const result = await markTestCompanyAction(PAYER, "staff", KEY);
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/numbers/test-accounts/${PAYER}`,
      expect.objectContaining({
        method: "PUT",
        body: { reason: "staff" },
        headers: { "idempotency-key": KEY },
      }),
    );
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("unmark is a DELETE with no key", async () => {
    adminFetch.mockResolvedValueOnce({ payer_id: PAYER, is_test_account: false, changed: false });
    const result = await unmarkTestCompanyAction(PAYER);
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/numbers/test-accounts/${PAYER}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  it("refuses a malformed id or key before any request", async () => {
    expect((await markTestCompanyAction("not-an-id", "staff", KEY)).ok).toBe(false);
    expect((await markTestCompanyAction(PAYER, "staff", "short")).ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("logging a call", () => {
  it("POSTs one closed result with its own key", async () => {
    adminFetch.mockResolvedValueOnce({
      call: {
        id: "ca110000-0001-4a00-8000-000000000001",
        payer_id: PAYER,
        called_at: "2026-11-17T00:00:00.000Z",
        result: "reached_will_buy",
        admin_id: "a-1",
      },
      created: true,
    });
    const result = await logCreditCallAction(PAYER, "reached_will_buy", KEY);
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/numbers/out-of-credits/${PAYER}/calls`,
      expect.objectContaining({
        method: "POST",
        body: { result: "reached_will_buy" },
        headers: { "idempotency-key": KEY },
      }),
    );
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("a replay is a successful no-op", async () => {
    adminFetch.mockResolvedValueOnce({
      call: {
        id: "ca110000-0001-4a00-8000-000000000001",
        payer_id: PAYER,
        called_at: "2026-11-17T00:00:00.000Z",
        result: "no_answer",
        admin_id: "a-1",
      },
      created: false,
    });
    const result = await logCreditCallAction(PAYER, "no_answer", KEY);
    expect(result).toMatchObject({ ok: true, changed: false });
  });
});

describe("launch test A writes", () => {
  const input = {
    factoryName: "Acme Works",
    cityGroup: "ncr" as const,
    tradeGroup: "cnc_operator" as const,
    sentAt: "2026-11-17T09:00:00.000Z",
    workerIds: [WORKER],
    idempotencyKey: KEY,
  };

  it("records a factory with snake-case fields and the key", async () => {
    adminFetch.mockResolvedValueOnce({ factory: { id: FACTORY }, created: true });
    const result = await recordLaunchFactoryAction(input);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/launch-tests/cohort",
      expect.objectContaining({
        method: "POST",
        headers: { "idempotency-key": KEY },
        body: {
          factory_name: "Acme Works",
          city_group: "ncr",
          trade_group: "cnc_operator",
          sent_at: "2026-11-17T09:00:00.000Z",
          worker_ids: [WORKER],
        },
      }),
    );
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("refuses more than five workers, duplicates and a link time without a link", async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      `1e110000-0001-4a00-8000-00000000000${i + 1}`,
    );
    expect((await recordLaunchFactoryAction({ ...input, workerIds: many })).ok).toBe(false);
    expect(
      (await recordLaunchFactoryAction({ ...input, workerIds: [WORKER, WORKER] })).ok,
    ).toBe(false);
    expect(
      (
        await recordLaunchFactoryAction({
          ...input,
          linkCreatedAt: "2026-11-17T09:00:00.000Z",
        })
      ).ok,
    ).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("PATCHes only the supplied fields with the key", async () => {
    adminFetch.mockResolvedValueOnce({ factory: { id: FACTORY }, changed: true });
    const result = await updateLaunchFactoryAction(
      FACTORY,
      { result: "paid", paidAt: "2026-11-17T10:00:00.000Z" },
      KEY,
    );
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/launch-tests/cohort/${FACTORY}`,
      expect.objectContaining({
        method: "PATCH",
        headers: { "idempotency-key": KEY },
        body: { result: "paid", paid_at: "2026-11-17T10:00:00.000Z" },
      }),
    );
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("refuses an update with no fields", async () => {
    expect((await updateLaunchFactoryAction(FACTORY, {}, KEY)).ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });
});
