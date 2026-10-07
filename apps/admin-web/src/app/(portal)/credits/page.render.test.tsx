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
 * The credits page's simulated-money marking, asserted on the PAGE (#1856). `Stat` itself is
 * pinned in components/stat.render.test — that proves the adornment slot works, not that this
 * page fills it. A ₹ tile rendered here without `MockMoneyTag` would pass every component test
 * while a screenshot of it read as revenue, which is the failure the tag exists to prevent.
 *
 * So: under mock payments EVERY ₹ tile on the page carries the tag inside its value span, and the
 * fixture is built so there is such a tile to check (the count is asserted, not assumed). Under
 * live payments no tile does. The TABLE ₹ figures (by-reason amounts, ledger prices) carry no tag
 * by design, so the posture banner is their only marker: it is pinned above them too, including
 * when the summary read fails. The data seams are mocked; the page and its components are real.
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
    if (stub.summary instanceof Error) throw stub.summary;
    return stub.summary;
  },
  listLedger: async () => {
    stub.order.push("ledger");
    if (stub.ledger instanceof Error) throw stub.ledger;
    return stub.ledger;
  },
}));

const { default: CreditsPage } = await import("./page");
const { AdminRequestError } = await import("../../../lib/admin-http");

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
    expect(out).toContain(LIVE_POSTURE_BANNER);
    expect(out).not.toContain("Simulated money");
  });

  it("under mock payments ONE posture banner leads the page, above every ₹ table", async () => {
    const out = await render();
    expect(out.split(MOCK_POSTURE_BANNER)).toHaveLength(2);
    const firstTable = out.indexOf("<table");
    // Not vacuous: the tables below it carry ₹ figures of their own.
    expect(firstTable).toBeGreaterThanOrEqual(0);
    expect(out.slice(firstTable)).toContain("₹18,000");
    expect(out.slice(firstTable)).toContain("₹1,500");
    expect(out.indexOf(MOCK_POSTURE_BANNER)).toBeLessThan(firstTable);
  });

  it("a failed summary read keeps the banner: the ledger's posture still marks its ₹ prices", async () => {
    stub.summary = new Error("summary read failed");
    const out = await render();
    const ledgerTable = out.indexOf("<table");
    expect(ledgerTable).toBeGreaterThanOrEqual(0);
    expect(out.slice(ledgerTable)).toContain("₹1,500");
    expect(out.indexOf(MOCK_POSTURE_BANNER)).toBeGreaterThanOrEqual(0);
    expect(out.indexOf(MOCK_POSTURE_BANNER)).toBeLessThan(ledgerTable);
  });
});

/**
 * The two chip rows are two filters on one URL (owner brief 2026-10-01): picking a window kept
 * no reason, and picking a reason reset the window — each row silently undid the other.
 */
describe("the window and reason chips keep each other", () => {
  const renderWith = async (sp: Record<string, string>) =>
    renderToStaticMarkup(await CreditsPage({ searchParams: Promise.resolve(sp) }));

  it("a window chip keeps the ledger's reason", async () => {
    const out = await renderWith({ windowDays: "7", reason: "grant" });
    expect(out).toContain('href="/credits?windowDays=30&amp;reason=grant"');
    expect(out).toContain('href="/credits?windowDays=90&amp;reason=grant"');
  });

  it("a reason chip keeps the window", async () => {
    const out = await renderWith({ windowDays: "7", reason: "grant" });
    expect(out).toContain('href="/credits?windowDays=7&amp;reason=unlock_debit"');
    expect(out).toContain('href="/credits?windowDays=7&amp;reason=refund"');
  });

  it("marks the active chip in each row for assistive tech", async () => {
    const out = await renderWith({ windowDays: "7", reason: "grant" });
    const current = out.match(/<[a-z]+ aria-current="true"[^>]*>(<i [^>]*><\/i>)?[^<]*/g) ?? [];
    expect(current.map((tag) => tag.replace(/<i [^>]*><\/i>/, "").split(">").pop())).toEqual([
      "7d",
      "Credit grant",
    ]);
  });

  it("the active chips are text, never a link to the page they are on (final re-sweep O-2)", async () => {
    const out = await renderWith({ windowDays: "7", reason: "grant" });
    // The address this page is on: a selected chip used to link it, beside the other row's.
    expect(out).not.toContain('href="/credits?windowDays=7&amp;reason=grant"');
    const current = out.match(/<[a-z]+ aria-current="true"[^>]*>/g) ?? [];
    expect(current).toHaveLength(2);
    for (const tag of current) expect(tag).toMatch(/^<span /);
  });

  it("clearing the reason keeps the window, and says it clears that one filter", async () => {
    const out = await renderWith({ windowDays: "7", reason: "grant" });
    expect(out).toMatch(/href="\/credits\?windowDays=7">(<i [^>]*><\/i>)?Clear the reason filter<\/a>/);
    expect(out).not.toContain(">Clear filters<");
  });
});

/**
 * ONE LINK PER TARGET (sweep AW-16). On a fresh platform the balances and the ledger are both
 * empty and each offered "Open payment orders"; in an outage both reads fail and each offered a
 * "Retry" to the same address. The ledger owns both — the paged list, where a purchase lands —
 * and the position offers its copy only when the ledger is not showing one.
 */
describe("credits — each recovery once on the screen", () => {
  const renderWith = async (sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await CreditsPage({ searchParams: Promise.resolve(sp) }));
  const count = (out: string, s: string) => out.split(s).length - 1;

  it("both empty: one Open payment orders, in the empty ledger", async () => {
    stub.summary = { ...summary(MOCK), by_reason: [], top_balances: [] };
    stub.ledger = { ...ledger(MOCK), items: [] };
    const out = await renderWith();
    expect(out).toContain("No customer holds a credit balance yet");
    expect(out).toContain("No credit movements recorded yet");
    expect(count(out, ">Open payment orders<")).toBe(1);
    expect(out.indexOf(">Open payment orders<")).toBeGreaterThan(
      out.indexOf("No credit movements recorded yet"),
    );
  });

  it("no balances but a ledger with rows: the balances state keeps its own link", async () => {
    stub.summary = { ...summary(MOCK), top_balances: [] };
    const out = await renderWith();
    expect(count(out, ">Open payment orders<")).toBe(1);
  });

  it("both reads failed: one Retry, the ledger's, and the position says so", async () => {
    stub.summary = new Error("summary read failed");
    stub.ledger = new Error("ledger read failed");
    const out = await renderWith({ windowDays: "7", reason: "grant", cursor: "c2" });
    expect(count(out, ">Retry<")).toBe(1);
    expect(out).toMatch(
      /href="\/credits\?windowDays=7&amp;reason=grant&amp;cursor=c2">(<i [^>]*><\/i>)?Retry<\/a>/,
    );
    expect(out).toContain("its Retry reads both again");
    expect(out).not.toContain("is unaffected");
  });

  it("only the position failed: its own Retry, and the ledger is said to be unaffected", async () => {
    stub.summary = new Error("summary read failed");
    const out = await renderWith({ windowDays: "7" });
    expect(count(out, ">Retry<")).toBe(1);
    expect(out).toContain("The credit ledger below is a separate read and is unaffected.");
  });

  it("names the holder of a balance or a movement 'Customer' — never 'Account' (sweep AW-12)", async () => {
    const out = await renderWith();
    expect(count(out, '<th scope="col">Customer</th>')).toBe(2);
    expect(out).not.toContain('<th scope="col">Account</th>');
  });
});

/**
 * THE CUSTOMER CELLS (#2032, sweep AW-28). A ledger movement carries `payer_role`, so its cell
 * goes straight to the customer's own section and names the persona. A top balance does not —
 * the summary never served a role — so it keeps the address that redirects an agency on.
 */
describe("credits — a customer cell links the customer's own section", () => {
  const withLedgerRole = (payer_role: unknown) => {
    const page = ledger(MOCK);
    stub.ledger = { ...page, items: page.items.map((row) => ({ ...row, payer_role })) };
  };
  const count = (out: string, s: string) => out.split(s).length - 1;
  /** The top balance's cell: never a role, so always the fallback, never a persona. */
  const BALANCE = customerCell(PAYER, `/companies/${PAYER}`, null, "</td>");

  it("an agency's movement links /agencies/<id> directly, named Agency", async () => {
    withLedgerRole("agent");
    const out = await render();
    expect(out).toContain(customerCell(PAYER, `/agencies/${PAYER}`, "Agency", "</td>"));
    // …and the only /companies/ link left is the top balance's.
    expect(count(out, `href="/companies/${PAYER}"`)).toBe(1);
    expect(out).toContain(BALANCE);
  });

  it("a company's movement links /companies/<id>, named Company", async () => {
    withLedgerRole("employer");
    const out = await render();
    expect(out).toContain(customerCell(PAYER, `/companies/${PAYER}`, "Company", "</td>"));
    expect(out).not.toContain(`href="/agencies/${PAYER}"`);
  });

  it("a null role (an orphaned id) falls back to /companies/<id>, claiming no persona", async () => {
    withLedgerRole(null);
    const out = await render();
    // The movement AND the top balance: both the fallback, neither naming a persona.
    expect(count(out, BALANCE)).toBe(2);
  });

  it("an absent role (an older API) falls back the same way", async () => {
    const out = await render();
    expect(ledger(MOCK).items[0]).not.toHaveProperty("payer_role");
    expect(count(out, BALANCE)).toBe(2);
  });
});

/** The href of the link whose visible label (after any glyph) is exactly `label`. */
const hrefOf = (out: string, label: string) =>
  [...out.matchAll(/href="([^"]*)">(?:<i [^>]*><\/i>)?([^<]*)<\/a>/g)].find((m) => m[2] === label)?.[1];

/**
 * A failed ledger read, by the console's one rule (final re-sweep O-3). The ledger is the paged
 * list here, and its reason is the one filter that reaches it (the reporting window is the
 * position's, and only 7/30/90 are ever sent). A refused reason is cleared — keeping the window —
 * and a refused cursor goes back to the first page; neither offers a Retry of a refused read.
 */
describe("a failed ledger read: refused or unavailable (final re-sweep O-3)", () => {
  const renderWith = async (sp: Record<string, string>) =>
    renderToStaticMarkup(await CreditsPage({ searchParams: Promise.resolve(sp) }));
  const count = (out: string, s: string) => out.split(s).length - 1;
  const ledgerPanel = (out: string) => out.slice(out.indexOf('id="cr-ledger"'));

  it("a 400 with a reason set: the reason was refused — its clear, in the state, keeps the window", async () => {
    stub.ledger = new AdminRequestError(400, "Invalid enum value");
    const out = await renderWith({ windowDays: "7", reason: "bogus" });
    expect(out).toContain("The server rejected the reason filter");
    expect(out).not.toContain("The ledger is unavailable");
    expect(out).not.toContain(">Retry<");
    expect(count(out, ">Clear the reason filter<")).toBe(1);
    expect(ledgerPanel(out).indexOf(">Clear the reason filter<")).toBeGreaterThan(
      ledgerPanel(out).indexOf("The server rejected the reason filter"),
    );
    expect(hrefOf(out, "Clear the reason filter")).toBe("/credits?windowDays=7");
  });

  it("a 400 with only a page cursor: the cursor was refused — Back to the first page, no Retry", async () => {
    stub.ledger = new AdminRequestError(400, "cursor too long");
    const out = await renderWith({ windowDays: "7", cursor: "c2" });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain(">Retry<");
    expect(hrefOf(out, "Back to the first page")).toBe("/credits?windowDays=7");
  });

  it("a 400 with nothing in the address is an outage — Retry", async () => {
    stub.ledger = new AdminRequestError(400, "Invalid filter value.");
    const out = await renderWith({});
    expect(out).toContain("The ledger is unavailable");
    expect(out).not.toContain("rejected");
    expect(hrefOf(out, "Retry")).toBe("/credits?windowDays=30");
  });

  it("a refused ledger offers no Retry, so a failed position keeps its own", async () => {
    stub.ledger = new AdminRequestError(400, "Invalid enum value");
    stub.summary = new Error("summary read failed");
    const out = await renderWith({ windowDays: "7", reason: "bogus" });
    expect(count(out, ">Retry<")).toBe(1);
    expect(out.indexOf(">Retry<")).toBeLessThan(out.indexOf('id="cr-ledger"'));
    expect(out).not.toContain("its Retry reads both again");
  });
});

/**
 * ONE LINK PER TARGET (final re-sweep O-2): a quiet window's state offered "Widen to 90 days",
 * the same address as the 90d chip above it — and it dropped the ledger's reason doing so.
 */
describe("a quiet reporting window points at the window chips, not a second link to one", () => {
  it("no second link to the 90-day window", async () => {
    stub.summary = { ...summary(MOCK), by_reason: [] };
    const out = renderToStaticMarkup(
      await CreditsPage({ searchParams: Promise.resolve({ windowDays: "30" }) }),
    );
    expect(out).toContain("No credit movement in this window");
    expect(out.split('href="/credits?windowDays=90"')).toHaveLength(2);
    expect(out).not.toContain("Widen to 90 days");
  });
});

/**
 * On a later page the selected chips are the way back to page one (review of #2095). Chips drop
 * the cursor, so their target is the first page of the same window and reason — not this address
 * — and the Pager only goes forward. They stay links there, still marked current.
 */
describe("on a later ledger page the selected chips link the first page", () => {
  it("both rows' selected chips go to page one of the same window and reason", async () => {
    const out = renderToStaticMarkup(
      await CreditsPage({
        searchParams: Promise.resolve({ windowDays: "7", reason: "grant", cursor: "c2" }),
      }),
    );
    expect(out.match(/<[a-z]+ aria-current="true"[^>]*>/g)).toEqual([
      '<a aria-current="true" class="btn btn--selected" href="/credits?windowDays=7&amp;reason=grant">',
      '<a aria-current="true" class="btn btn--sm btn--selected" href="/credits?windowDays=7&amp;reason=grant">',
    ]);
  });
});

/**
 * A reason the chips offer is never the refused part (review of #2095). With a valid reason and
 * an over-long cursor (the API's bound is 256 characters), the 400 is the CURSOR's — the reason
 * copy ("not one the ledger records") was false there.
 */
describe("a valid reason with a refused cursor gets the cursor's copy", () => {
  it("a chip's reason plus an over-long cursor: the page was refused, not the reason", async () => {
    stub.ledger = new AdminRequestError(400, "cursor too long");
    const out = renderToStaticMarkup(
      await CreditsPage({
        searchParams: Promise.resolve({ windowDays: "7", reason: "grant", cursor: "x".repeat(300) }),
      }),
    );
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain("The server rejected the reason filter");
    expect(out).not.toContain("not one the ledger records");
    expect(out).not.toContain(">Retry<");
    expect(hrefOf(out, "Back to the first page")).toBe("/credits?windowDays=7&amp;reason=grant");
  });

  it("a reason the chips do not offer is still the refused part, cursor or not", async () => {
    stub.ledger = new AdminRequestError(400, "Invalid enum value");
    const out = renderToStaticMarkup(
      await CreditsPage({
        searchParams: Promise.resolve({ windowDays: "7", reason: "bogus", cursor: "x".repeat(300) }),
      }),
    );
    expect(out).toContain("The server rejected the reason filter");
  });

  it("a chip's reason with no cursor cannot have been refused: the 400 is ours — an outage", async () => {
    stub.ledger = new AdminRequestError(400, "Invalid filter value.");
    const out = renderToStaticMarkup(
      await CreditsPage({ searchParams: Promise.resolve({ windowDays: "7", reason: "grant" }) }),
    );
    expect(out).toContain("The ledger is unavailable");
    expect(out).not.toContain("rejected");
  });
});
