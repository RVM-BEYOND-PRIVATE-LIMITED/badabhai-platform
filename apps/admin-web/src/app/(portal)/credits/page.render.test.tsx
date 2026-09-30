import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SIMULATED_TAG, isRupeeTile, statTiles } from "../../../../test/stat-tiles";

/**
 * The credits page's simulated-money marking, asserted on the PAGE (#1856). `Stat` itself is
 * pinned in components/stat.render.test — that proves the adornment slot works, not that this
 * page fills it. A ₹ tile rendered here without `MockMoneyTag` would pass every component test
 * while a screenshot of it read as revenue, which is the failure the tag exists to prevent.
 *
 * So: under mock payments EVERY ₹ tile on the page carries the tag inside its value span, and the
 * fixture is built so there is such a tile to check (the count is asserted, not assumed). Under
 * live payments no tile does. The data seams are mocked; the page and its components are real.
 */
const stub = vi.hoisted(() => ({
  order: [] as string[],
  summary: null as unknown,
  ledger: null as unknown,
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
  listLedger: async () => {
    stub.order.push("ledger");
    return stub.ledger;
  },
}));

const { default: CreditsPage } = await import("./page");

const MOCK = { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL=false" } as const;
const REAL = { mode: "real", blocked_reason: null } as const;
const PAYER = "8a110000-0001-4a00-8000-000000000001";

const summary = (payments: typeof MOCK | typeof REAL) => ({
  payments,
  window_days: 30,
  outstanding_credits: 123456,
  payers_with_balance: 42,
  by_reason: [
    { reason: "pack_purchase", movements: 12, credits_delta: 1200, amount_inr: 18000 },
    { reason: "unlock_debit", movements: 40, credits_delta: -40, amount_inr: 0 },
  ],
  paid_orders: { count: 7, credits: 700, amount_inr: 214538 },
  unsettled_orders: { count: 2, amount_inr: 3000 },
  failed_orders: { count: 1 },
  top_balances: [{ payer_id: PAYER, balance: 500 }],
});

const ledger = (payments: typeof MOCK | typeof REAL) => ({
  payments,
  nextCursor: null,
  items: [
    {
      id: "1e000000-0001-4a00-8000-000000000001",
      payer_id: PAYER,
      delta: 100,
      reason: "pack_purchase",
      unlock_id: null,
      pack_code: "starter_100",
      price_inr: 1500,
      created_at: "2026-09-20T09:00:00.000Z",
    },
  ],
});

beforeEach(() => {
  stub.order.length = 0;
  stub.summary = summary(MOCK);
  stub.ledger = ledger(MOCK);
});

const render = async () =>
  renderToStaticMarkup(await CreditsPage({ searchParams: Promise.resolve({}) }));

describe("credits — simulated money is marked on the page", () => {
  it("gates on read_entities before either read runs", async () => {
    await render();
    expect(stub.order[0]).toBe("gate:read_entities");
  });

  it("under mock payments, every ₹ tile carries the simulated tag inside its value", async () => {
    const rupees = statTiles(await render()).filter(isRupeeTile);
    // Not vacuous: the settled-orders tile is the page's ₹ tile.
    expect(rupees.map((t) => t.label)).toEqual(["Settled in 30d (7 orders)"]);
    for (const t of rupees) expect(t.valueHtml, t.label).toContain(SIMULATED_TAG);
  });

  it("keeps the tag beside the figure it qualifies, not elsewhere on the tile", async () => {
    const [settled] = statTiles(await render()).filter(isRupeeTile);
    expect(settled!.valueHtml.startsWith("₹")).toBe(true);
    expect(settled!.valueHtml.endsWith(` ${SIMULATED_TAG}`)).toBe(true);
    expect(settled!.label).not.toContain("simulated");
  });

  it("tags money only — the credit COUNTS are real platform state and stay untagged", async () => {
    const counts = statTiles(await render()).filter((t) => !isRupeeTile(t));
    expect(counts.length).toBeGreaterThan(0);
    for (const t of counts) expect(t.valueHtml, t.label).not.toContain("simulated");
  });

  it("under live payments no tile is tagged, and the ₹ figure still renders", async () => {
    stub.summary = summary(REAL);
    stub.ledger = ledger(REAL);
    const out = await render();
    const rupees = statTiles(out).filter(isRupeeTile);
    expect(rupees).toHaveLength(1);
    expect(out).not.toContain(SIMULATED_TAG);
  });
});
