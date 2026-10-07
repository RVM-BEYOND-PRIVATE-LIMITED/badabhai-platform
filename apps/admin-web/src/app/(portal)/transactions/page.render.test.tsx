import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LIVE_POSTURE_BANNER,
  MOCK_POSTURE_BANNER,
  SIMULATED_TAG,
  isRupeeTile,
  statTiles,
} from "../../../../test/stat-tiles";
import { customerCell } from "../../../../test/customer-cell";

/**
 * The transactions page's simulated-money marking, asserted on the PAGE (#1856). The ₹ tile here
 * has TWO call sites — the mock-path pack-purchase tile (ledger-side, shown while payments are
 * mocked and a purchase exists) and the settled-orders tile otherwise — and each renders its own
 * `MockMoneyTag`, so each branch is rendered and checked. The orders table's ₹ amounts carry no
 * tag by design; the posture banner above them is their only marker, and is pinned too. See
 * credits/page.render.test.tsx for why the component test alone does not cover this.
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
    if (stub.summary instanceof Error) throw stub.summary;
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
    expect(out).toContain(LIVE_POSTURE_BANNER);
    expect(out).not.toContain("Simulated money");
  });

  it("under mock payments ONE posture banner leads the page, above the orders table", async () => {
    const out = await render();
    expect(out.split(MOCK_POSTURE_BANNER)).toHaveLength(2);
    const table = out.indexOf("<table");
    // Not vacuous: the order amounts in the table are ₹ figures with no tag of their own.
    expect(table).toBeGreaterThanOrEqual(0);
    expect(out.slice(table)).toContain("₹1,500");
    expect(out.indexOf(MOCK_POSTURE_BANNER)).toBeLessThan(table);
  });

  it("a failed summary read keeps the banner: the orders' posture still marks their ₹ amounts", async () => {
    stub.summary = new Error("summary read failed");
    const out = await render();
    const table = out.indexOf("<table");
    expect(table).toBeGreaterThanOrEqual(0);
    expect(out.slice(table)).toContain("₹1,500");
    expect(out.indexOf(MOCK_POSTURE_BANNER)).toBeGreaterThanOrEqual(0);
    expect(out.indexOf(MOCK_POSTURE_BANNER)).toBeLessThan(table);
  });
});

describe("the status chips keep an account narrowing (owner brief 2026-10-01)", () => {
  const renderWith = async (sp: Record<string, string>) =>
    renderToStaticMarkup(await TransactionsPage({ searchParams: Promise.resolve(sp) }));
  const PAYER = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

  it("a chip carries ?payerId= — it used to drop it and widen to every account", async () => {
    const out = await renderWith({ status: "paid", payerId: PAYER });
    expect(out).toContain(`href="/transactions?status=failed&amp;payerId=${PAYER}"`);
    expect(out).toContain(`href="/transactions?status=created&amp;payerId=${PAYER}"`);
  });

  it("marks the active chip, and only it", async () => {
    const out = await renderWith({ status: "paid", payerId: PAYER });
    expect(out).toMatch(/aria-current="true"[^>]*href="\/transactions\?status=paid&amp;payerId=/);
    expect((out.match(/aria-current="true"/g) ?? []).length).toBe(1);
  });

  it("without a narrowing, a chip is just the status", async () => {
    const out = await renderWith({});
    expect(out).toContain('href="/transactions?status=paid"');
  });
});

describe("the orders table names the payer the console's way", () => {
  it("'Customer' — never 'Account', which is the payer's own settings page (sweep AW-12)", async () => {
    const out = await render();
    expect(out).toContain('<th scope="col">Customer</th>');
    expect(out).not.toContain('<th scope="col">Account</th>');
  });
});

/**
 * THE CUSTOMER CELL (#2032, sweep AW-28): straight to the customer's own section when the order
 * names the payer's role, with the persona beside the id; the redirecting address when it does not.
 */
describe("the orders table links the customer's own section", () => {
  const PAYER = "8a110000-0001-4a00-8000-000000000001";
  const withRole = (payer_role: unknown) => {
    const page = orders(MOCK);
    stub.orders = { ...page, items: page.items.map((o) => ({ ...o, payer_role })) };
  };

  it("an agency's order links /agencies/<id> directly, named Agency", async () => {
    withRole("agent");
    const out = await render();
    expect(out).toContain(customerCell(PAYER, `/agencies/${PAYER}`, "Agency", "</td>"));
    expect(out).not.toContain(`href="/companies/${PAYER}"`);
  });

  it("a company's order links /companies/<id>, named Company", async () => {
    withRole("employer");
    const out = await render();
    expect(out).toContain(customerCell(PAYER, `/companies/${PAYER}`, "Company", "</td>"));
    expect(out).not.toContain(`href="/agencies/${PAYER}"`);
  });

  it("a null role (an orphaned id) falls back to /companies/<id>, claiming no persona", async () => {
    withRole(null);
    const out = await render();
    expect(out).toContain(customerCell(PAYER, `/companies/${PAYER}`, null, "</td>"));
  });

  it("an absent role (an older API) falls back the same way", async () => {
    const out = await render();
    expect(orders(MOCK).items[0]).toHaveProperty("payer_id", PAYER);
    expect(orders(MOCK).items[0]).not.toHaveProperty("payer_role");
    expect(out).toContain(customerCell(PAYER, `/companies/${PAYER}`, null, "</td>"));
  });
});
