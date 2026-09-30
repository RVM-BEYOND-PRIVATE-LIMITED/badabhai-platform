import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SIMULATED_TAG, isRupeeTile, statTiles } from "../../../../test/stat-tiles";

/**
 * The transactions page's simulated-money marking, asserted on the PAGE (#1856). The ₹ tile here
 * has TWO call sites — the mock-path pack-purchase tile (ledger-side, shown while payments are
 * mocked and a purchase exists) and the settled-orders tile otherwise — and each renders its own
 * `MockMoneyTag`, so each branch is rendered and checked. See credits/page.render.test.tsx for why
 * the component test alone does not cover this.
 */
const stub = vi.hoisted(() => ({
  order: [] as string[],
  summary: null as unknown,
  orders: null as unknown,
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "ops_admin", capabilities: [capability] };
  },
}));

vi.mock("../../../lib/entities", () => ({
  getFinanceSummary: async () => {
    stub.order.push("summary");
    return stub.summary;
  },
  listOrders: async () => {
    stub.order.push("orders");
    return stub.orders;
  },
}));

const { default: TransactionsPage } = await import("./page");

const MOCK = { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL=false" } as const;
const REAL = { mode: "real", blocked_reason: null } as const;
type Posture = typeof MOCK | typeof REAL;

const PACK_PURCHASE = { reason: "pack_purchase", movements: 2, credits_delta: 200, amount_inr: 3000 };

const summary = (payments: Posture, byReason: unknown[]) => ({
  payments,
  window_days: 30,
  outstanding_credits: 900,
  payers_with_balance: 3,
  by_reason: byReason,
  paid_orders: { count: 4, credits: 400, amount_inr: 6000 },
  unsettled_orders: { count: 1, amount_inr: 1500 },
  failed_orders: { count: 0 },
  top_balances: [],
});

const orders = (payments: Posture) => ({
  payments,
  nextCursor: null,
  items: [
    {
      id: "0d000000-0001-4a00-8000-000000000001",
      payer_id: "8a110000-0001-4a00-8000-000000000001",
      pack_code: "starter_100",
      amount_inr: 1500,
      credits_granted: 100,
      provider: "razorpay",
      status: "paid",
      created_at: "2026-09-20T09:00:00.000Z",
      updated_at: "2026-09-20T09:00:00.000Z",
    },
  ],
});

beforeEach(() => {
  stub.order.length = 0;
  stub.summary = summary(MOCK, [PACK_PURCHASE]);
  stub.orders = orders(MOCK);
});

const render = async () =>
  renderToStaticMarkup(await TransactionsPage({ searchParams: Promise.resolve({}) }));

describe("transactions — simulated money is marked on the page", () => {
  it("gates on read_entities before either read runs", async () => {
    await render();
    expect(stub.order[0]).toBe("gate:read_entities");
  });

  it("mock purchases recorded in the ledger: the ₹ tile carries the tag", async () => {
    const rupees = statTiles(await render()).filter(isRupeeTile);
    expect(rupees).toHaveLength(1);
    expect(rupees[0]!.label).toContain("Pack purchases via the mock path (2)");
    expect(rupees[0]!.className).toBe("stat stat--warn stat--wide");
    expect(rupees[0]!.valueHtml).toBe(`₹3,000 ${SIMULATED_TAG}`);
  });

  it("mock payments with no ledger purchase: the settled tile carries the tag", async () => {
    stub.summary = summary(MOCK, []);
    const rupees = statTiles(await render()).filter(isRupeeTile);
    expect(rupees).toHaveLength(1);
    expect(rupees[0]!.label).toBe("Settled (4 orders)");
    expect(rupees[0]!.valueHtml).toBe(`₹6,000 ${SIMULATED_TAG}`);
  });

  it("tags money only — the order and credit COUNTS stay untagged", async () => {
    const counts = statTiles(await render()).filter((t) => !isRupeeTile(t));
    expect(counts.length).toBeGreaterThan(0);
    for (const t of counts) expect(t.valueHtml, t.label).not.toContain("simulated");
  });

  it("under live payments the settled tile renders its figure with no tag", async () => {
    stub.summary = summary(REAL, [PACK_PURCHASE]);
    stub.orders = orders(REAL);
    const out = await render();
    const rupees = statTiles(out).filter(isRupeeTile);
    expect(rupees.map((t) => t.label)).toEqual(["Settled (4 orders)"]);
    expect(out).not.toContain(SIMULATED_TAG);
  });
});
