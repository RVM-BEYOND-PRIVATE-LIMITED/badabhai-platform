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
    if (stub.orders instanceof Error) throw stub.orders;
    return stub.orders;
  },
}));

const { default: TransactionsPage } = await import("./page");
const { AdminRequestError } = await import("../../../lib/admin-http");

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

  it("marks the active chip, and only it — as text, not a link to this page (final re-sweep O-2)", async () => {
    const out = await renderWith({ status: "paid", payerId: PAYER });
    expect(out).toMatch(/<span aria-current="true" class="btn btn--sm btn--selected">Settled<\/span>/);
    expect((out.match(/aria-current="true"/g) ?? []).length).toBe(1);
    expect(out).not.toContain(`href="/transactions?status=paid&amp;payerId=${PAYER}"`);
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

/** The href of the link whose visible label (after any glyph) is exactly `label`. */
const hrefOf = (out: string, label: string) =>
  [...out.matchAll(/href="([^"]*)">(?:<i [^>]*><\/i>)?([^<]*)<\/a>/g)].find((m) => m[2] === label)?.[1];

/**
 * A failed order read, by the console's one rule (final re-sweep O-3): the page read every
 * failure as an outage, so a hand-edited `?status=` earned a Retry that could only be refused
 * again. A refused filter is cleared, a refused cursor goes back to the first page, and a 400
 * with nothing in the address — or anything else — is an outage with Retry.
 */
describe("a failed order read: refused or unavailable (final re-sweep O-3)", () => {
  const renderWith = async (sp: Record<string, string>) =>
    renderToStaticMarkup(await TransactionsPage({ searchParams: Promise.resolve(sp) }));
  const count = (out: string, s: string) => out.split(s).length - 1;
  const errorState = (out: string) => out.slice(out.indexOf('class="state state--error"'));

  it("a 400 with a filter set: the filters were refused — Clear filters in the state, no Retry", async () => {
    stub.orders = new AdminRequestError(400, "Invalid enum value");
    const out = await renderWith({ status: "bogus", cursor: "c2" });
    expect(out).toContain("The server rejected these filters");
    expect(out).not.toContain("Payment orders are unavailable");
    expect(out).not.toContain(">Retry<");
    expect(out).not.toContain(">Back to the first page<");
    expect(count(out, ">Clear filters<")).toBe(1);
    expect(errorState(out)).toContain(">Clear filters<");
    expect(hrefOf(out, "Clear filters")).toBe("/transactions");
  });

  it("a 400 with only a page cursor: the cursor was refused — Back to the first page, no Retry", async () => {
    stub.orders = new AdminRequestError(400, "cursor too long");
    const out = await renderWith({ cursor: "c2" });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain(">Retry<");
    expect(out).not.toContain(">Clear filters<");
    expect(hrefOf(out, "Back to the first page")).toBe("/transactions");
  });

  it("a 400 with nothing in the address is an outage — it cannot be the operator's", async () => {
    stub.orders = new AdminRequestError(400, "Invalid filter value.");
    const out = await renderWith({});
    expect(out).toContain("Payment orders are unavailable");
    expect(out).not.toContain("rejected");
    expect(hrefOf(out, "Retry")).toBe("/transactions");
  });

  it("a 5xx is an outage: Retry repeats the query, cursor included; the first page keeps the filters", async () => {
    stub.orders = new AdminRequestError(500, "boom");
    const out = await renderWith({ status: "paid", cursor: "c2" });
    expect(out).toContain("Payment orders are unavailable");
    expect(out).not.toContain("rejected");
    expect(hrefOf(out, "Retry")).toBe("/transactions?status=paid&amp;cursor=c2");
    expect(hrefOf(out, "Back to the first page")).toBe("/transactions?status=paid");
  });
});
