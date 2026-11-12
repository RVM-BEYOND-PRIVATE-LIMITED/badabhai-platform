import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import { lowBalanceThreshold, offeredCreditPacks } from "../../../lib/pricing-config";
import type { CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";

/**
 * CREDITS PAGE render tests — assert the page actually surfaces the nudge / history (and no
 * credit expiry or invoice, which the server does not apply yet — #2741, and no per-unlock
 * price — #2744) and that packs + the nudge threshold are PROVABLY config-sourced (not literals).
 *
 * The data seam (`payer-api`) is mocked so we control the balance + unlock/top-up ledger; but
 * `pricing-config` is REAL — so the rendered packs/threshold come from the
 * @badabhai/pricing catalog + the config functions, and the tests assert the rendered values
 * EQUAL those config outputs (drift-proof, i.e. not hardcoded). Env is node (no DOM): the async
 * server component is awaited to an element tree and walked. PII guard: no worker id / phone /
 * name / email may appear in any row.
 */

const getDashboard = vi.fn();
const getCreditTopUps = vi.fn();
vi.mock("../../../lib/payer-api", () => ({
  getDashboard: (o: unknown) => getDashboard(o),
  getCreditTopUps: () => getCreditTopUps(),
  // Transitively imported by ./credits-panel → ./actions; never called from a render test.
  topUp: vi.fn(),
  createCreditOrder: vi.fn(),
  verifyCreditPayment: vi.fn(),
}));
// Credits is open to EVERY payer member (owner ruling 2026-10-07): the page's gate is
// requirePayer() — signed in, any org role. Mocked through a referenced spy so the render tests
// ADMIT (default) and a dedicated test can make it redirect to /login.
const requirePayer = vi.fn();
vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
// The OWNER gate must no longer be consulted. It is mocked to refuse exactly as it would for a
// Recruiter, so a page that still called it would 404 every test below.
const requireOwner = vi.fn(() => Promise.reject(new Error("NEXT_NOT_FOUND")));
vi.mock("../../../lib/auth/org-roles", () => ({
  requireOwner: () => requireOwner(),
  getOrgRole: () => "recruiter",
}));
// The LIVE catalog seam (D-6). Default: live catalog = the default products (the tests
// below assert the rendered figures EQUAL the pricing-config outputs over these products);
// dedicated tests re-point it at an ops-EDITED catalog (live) or the fallback (live:false).
const getLiveCatalog = vi.fn();
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
// The SERVER-side payment-mode flag (real Razorpay vs mock top-up). Mocked because the real
// module memoizes its parse, so per-test env mutation would not take effect.
const payerServerConfig = vi.fn();
vi.mock("../../../lib/server-config", () => ({ payerServerConfig: () => payerServerConfig() }));

const { default: CreditsPage } = await import("./page");

const PAYER = "11111111-1111-4111-8111-111111111111";
const WORKER = "99999999-9999-4999-8999-999999999999"; // must NOT appear in any rendered row
const UNLOCK = "22222222-2222-4222-8222-222222222222";

const unlock = (over: Partial<UnlockHistoryItem> = {}): UnlockHistoryItem => ({
  unlockId: UNLOCK,
  workerId: WORKER,
  status: "granted",
  createdAt: "2026-01-12T00:00:00.000Z",
  expiresAt: "2026-01-26T00:00:00.000Z",
  ...over,
});
const topUp = (over: Partial<CreditTopUp> = {}): CreditTopUp => ({
  topUpId: "33333333-3333-4333-8333-333333333333",
  packCode: "pack_50",
  credits: 50,
  priceInr: 2000,
  createdAt: "2026-01-10T08:00:00.000Z",
  ...over,
});

function dashboard(balance: number, unlocks: UnlockHistoryItem[] = []): Dashboard {
  return { credits: { payerId: PAYER, balance }, unlocks, postings: [] };
}

function setData(opts: { balance: number; unlocks?: UnlockHistoryItem[]; topUps?: CreditTopUp[] }) {
  getDashboard.mockResolvedValue(dashboard(opts.balance, opts.unlocks ?? []));
  getCreditTopUps.mockResolvedValue(opts.topUps ?? []);
}

interface Collected {
  text: string[];
  /** Every `className` on the tree — the page-spine primitives are asserted through this. */
  classes: string[];
  panelPacks: unknown;
  /** The `real` flag the server page hands the client panel. */
  panelReal: unknown;
}
function collect(
  node: ReactNode,
  acc: Collected = { text: [], classes: [], panelPacks: undefined, panelReal: undefined },
): Collected {
  if (node === null || node === undefined || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, acc));
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.props && typeof el.props.className === "string") acc.classes.push(el.props.className);
  // The CreditsPanel child receives the config packs as a prop (we never hook-render it).
  if (el.props && "packs" in el.props && acc.panelPacks === undefined) {
    acc.panelPacks = el.props.packs;
    acc.panelReal = el.props.real;
  }
  // Expand a FUNCTION component one level (the DS primitives + CachedPricingNote are
  // hookless/presentational — the capacity-page walker pattern) so text rendered INSIDE a
  // component (not passed as a children prop) is reachable. A hook-using client child
  // (CreditsPanel) throws outside React → fall back to walking its children prop.
  if (typeof el.type === "function") {
    const Fn = el.type as (props: unknown) => ReactNode;
    let rendered: ReactNode = null;
    try {
      rendered = Fn(el.props);
    } catch {
      rendered = el.props && "children" in el.props ? el.props.children : null;
    }
    collect(rendered, acc);
    return acc;
  }
  if (el.props && "children" in el.props) collect(el.props.children as ReactNode, acc);
  return acc;
}
async function render(opts: {
  balance: number;
  unlocks?: UnlockHistoryItem[];
  topUps?: CreditTopUp[];
}) {
  setData(opts);
  const tree = (await CreditsPage()) as ReactElement;
  const c = collect(tree);
  return {
    joined: c.text.join(" "),
    flat: c.text.join(" ").replace(/\s+/g, " "),
    classes: c.classes,
    panelPacks: c.panelPacks,
    panelReal: c.panelReal,
  };
}

beforeEach(() => {
  getDashboard.mockReset();
  getCreditTopUps.mockReset();
  // Default: the LIVE catalog resolved (D-6) with the default products.
  getLiveCatalog.mockReset().mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
  // Default: a signed-in RECRUITER — the least-privileged member must see the whole page.
  requirePayer.mockReset().mockResolvedValue({
    payerId: "11111111-1111-4111-8111-111111111111",
    displayLabel: "Acme",
    role: "employer",
    status: "active",
    orgRole: "recruiter",
  });
  requireOwner.mockClear();
  // Default: MOCK payments (the launch-gate default). Real mode is opted into per-test.
  payerServerConfig.mockReset().mockReturnValue({
    apiBaseUrl: "http://localhost:3001",
    paymentsEnableReal: false,
    agencySupplyEnabled: false,
  });
});
afterEach(() => {
  delete process.env.PAYER_LOW_BALANCE_THRESHOLD;
});

describe("credits page — open to every payer member (owner ruling 2026-10-07)", () => {
  it("a RECRUITER renders Credits, packs included — the owner gate is never consulted", async () => {
    const { panelPacks, flat } = await render({ balance: 50 });
    expect(requireOwner).not.toHaveBeenCalled();
    expect(panelPacks).toEqual(offeredCreditPacks({ products: DEFAULT_CATALOG.products }));
    expect(flat).toMatch(/50/);
  });

  it("calls requirePayer() FIRST and propagates the /login redirect (no session never renders)", async () => {
    const REDIRECT = new Error("NEXT_REDIRECT");
    requirePayer.mockReset().mockRejectedValue(REDIRECT);
    setData({ balance: 50 });
    // The gate runs before any fetch/render — the page rejects with the redirect sentinel.
    await expect(CreditsPage()).rejects.toBe(REDIRECT);
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it("reads the balance and unlocks only — never the company postings list (it shows none)", async () => {
    await render({ balance: 50 });
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(getDashboard).toHaveBeenCalledWith({ withPostings: false });
  });
});

describe("credits page — (a) low-balance nudge shows ONLY below the CONFIG threshold", () => {
  it("uses the config threshold, not a literal: env-driven boundary flips the nudge", async () => {
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "8";
    expect(lowBalanceThreshold()).toBe(8); // the page reads THIS

    // 7 < 8 → nudge shows, and the copy interpolates the config threshold (8), not a literal 5.
    const below = await render({ balance: 7 });
    expect(below.joined).toMatch(/running low/i);
    expect(below.joined).toMatch(/below\s+8\s+credits/); // threshold value comes from config

    // 8 is NOT below 8 → no nudge. (A hardcoded 5 would have hidden at 7 too — this proves config.)
    const atThreshold = await render({ balance: 8 });
    expect(atThreshold.joined).not.toMatch(/running low/i);
  });

  it("does not show the nudge when the balance is comfortably above the threshold", async () => {
    const { joined } = await render({ balance: 50 });
    expect(joined).not.toMatch(/running low/i);
  });
});

describe("credits page — (b) history renders unlock + top-up rows", () => {
  it("renders a spend row per unlock and a top-up row from the mock ledger", async () => {
    const { joined } = await render({
      balance: 50,
      unlocks: [unlock()],
      topUps: [topUp({ credits: 50, priceInr: 2000 })],
    });
    expect(joined).toMatch(/History/);
    expect(joined).toContain("Unlock"); // spend row badge
    expect(joined).toContain("Purchase"); // a bought pack's row badge
    expect(joined).not.toContain("Top-up"); // "Top up" also named adding applicant slots
    expect(joined).toContain("-1"); // each unlock spends 1 credit
    expect(joined).toContain("+50"); // top-up credits
    expect(joined).toContain("₹2,000"); // the STAMPED amount, en-IN formatted
  });

  /**
   * D-6 MEDIUM-2: a legacy ledger row (written before the price stamp existed) has NO amount.
   * The row must still render, showing an honest dash — NEVER a price fabricated from the
   * current catalog (which is what retroactively re-priced the past).
   */
  it("a top-up with NO stamped price renders an honest dash, not a fabricated amount", async () => {
    const { joined } = await render({
      balance: 50,
      topUps: [topUp({ credits: 50, priceInr: undefined })],
    });
    // The movement still shows...
    expect(joined).toContain("Purchase");
    expect(joined).toContain("+50");
    // ...with a dash for the amount, and NO invented ₹ figure anywhere.
    expect(joined).toContain("—");
    // The row stays a dash — and the hero prints no unlock value to repeat the figure (#2744).
    expect(joined).not.toContain("₹2,000");
    expect(joined).not.toMatch(/₹0\b/); // never a fake zero either
  });
});

describe("credits page — (c) #2741: nothing the server does not do", () => {
  it("shows no credit expiry, validity date or invoice promise", async () => {
    const purchased = "2026-01-10T08:00:00.000Z";
    const { joined } = await render({ balance: 50, topUps: [topUp({ createdAt: purchased })] });
    expect(joined).toContain("2026-01-10"); // the purchase itself still shows in the history
    // The server stores no expiry, spends credits in no set order and issues no invoice (BB-D-04).
    expect(joined).not.toMatch(/Credit Expiry/i);
    expect(joined).not.toMatch(/valid until|valid for|validity/i);
    expect(joined).not.toMatch(/expir/i);
    expect(joined).not.toMatch(/oldest credits/i);
    expect(joined).not.toMatch(/invoice/i);
    expect(joined).not.toContain("2027-01-10"); // no browser-computed +12-month date
  });
});

describe("credits page — (d) zero PII in any row (ids/amounts only)", () => {
  it("never renders the worker id, a phone, a name, or an email", async () => {
    const { joined } = await render({
      balance: 50,
      unlocks: [unlock()],
      topUps: [topUp()],
    });
    // History rows reference the opaque UNLOCK id, never the worker id.
    expect(joined).not.toContain(WORKER);
    expect(joined).not.toMatch(/\d{10,}/); // no phone-length digit run
    expect(joined).not.toMatch(/\+\d{7,}/); // no +country-code phone
    expect(joined).not.toMatch(/@/); // no email
    expect(joined).not.toMatch(/\bname\b/i); // no name label
  });
});

describe("credits page — (e) packs resolve from the live catalog (not literals); no per-unlock price", () => {
  it("passes the catalog packs to the panel and shows no per-unlock price (#2744)", async () => {
    const { flat, panelPacks } = await render({ balance: 50 });
    // The rendered packs are EXACTLY the catalog-derived set — not a hardcoded 50/200/1000 list.
    expect(panelPacks).toEqual(offeredCreditPacks({ products: DEFAULT_CATALOG.products }));
    expect((panelPacks as unknown[]).length).toBeGreaterThan(0);
    // No rate per unlock anywhere on the page — the description, the hero, a stat.
    expect(flat).not.toMatch(/per (contact )?unlock|\/ unlock|standard rate|rate paid/i);
    expect(flat).not.toMatch(/1 credit = 1/i);
  });

  it("the default (mock) posture shows no mock / staging-preview copy (owner ruling 2026-10-07, F35)", async () => {
    const { joined } = await render({ balance: 50 });
    expect(joined).not.toMatch(/\bmock\b/i);
    expect(joined).not.toMatch(/staging preview/i);
    expect(joined).not.toMatch(/no real payment is taken/i);
    expect(joined).not.toMatch(/no money moves/i);
    // The description says what the page holds — and stops there.
    expect(joined).toContain(
      "Your credit balance, the packs on sale, and every credit you have bought or spent.",
    );
  });
});

/**
 * PAYMENT MODE — the page must never advertise a mode it is not in. The flag is resolved
 * SERVER-side and handed to the panel; the client cannot pick its own mode.
 */
describe("credits page — real vs mock payment mode (server-decided)", () => {
  it("DEFAULTS to mock: real=false on the panel, with no mock copy and no claim that Razorpay is live", async () => {
    const { joined, panelReal } = await render({ balance: 50 });
    expect(panelReal).toBe(false);
    // The mode still decides the flow (real=false above); only its copy is gone (F35).
    expect(joined).not.toMatch(/Mock payments only/i);
    expect(joined).not.toMatch(/no real payment is taken/i);
    // What must never appear in mock mode is any claim that Razorpay is LIVE here.
    expect(joined).not.toMatch(/Pay securely via Razorpay/i);
    expect(joined).not.toMatch(/Payments by Razorpay/i);
  });

  it("REAL mode passes real=true and swaps the copy — no 'no real payment is taken' lie", async () => {
    payerServerConfig.mockReturnValue({
      apiBaseUrl: "http://localhost:3001",
      paymentsEnableReal: true,
      agencySupplyEnabled: false,
    });
    const { joined, panelReal } = await render({ balance: 50 });
    expect(panelReal).toBe(true);
    // The mock disclaimers must be GONE — rendering them beside a live charge is the
    // specific dishonesty this assertion exists to prevent.
    expect(joined).not.toMatch(/Mock payments only/i);
    expect(joined).not.toMatch(/no real payment is taken/i);
    expect(joined).not.toMatch(/no money moves/i);
    expect(joined).toMatch(/Pay securely via Razorpay/i);
    expect(joined).toMatch(/Payments by Razorpay/i);
  });

  it("never leaks a key/secret into the rendered page in EITHER mode", async () => {
    for (const paymentsEnableReal of [false, true]) {
      payerServerConfig.mockReturnValue({
        apiBaseUrl: "http://localhost:3001",
        paymentsEnableReal,
        agencySupplyEnabled: false,
      });
      const { joined } = await render({ balance: 50 });
      // The key id arrives at runtime on the ORDER response, never from this page.
      expect(joined).not.toMatch(/rzp_(test|live)_/);
      expect(joined).not.toMatch(/key_secret|whsec|PAYMENTS_PROVIDER_SECRET/i);
    }
  });
});

describe("credits page — (f) D-6: the LIVE catalog drives the packs; a failed read shows none (#2744)", () => {
  // An ops-EDITED live catalog: every unlock pack re-priced +₹500 — a compile-time
  // DEFAULT_CATALOG read could not show it.
  const EDITED = DEFAULT_CATALOG.products.map((p) =>
    p.kind === "credit_pack" && p.code === "contact_unlock"
      ? { ...p, tiers: p.tiers.map((t) => ({ ...t, priceInr: t.priceInr + 500 })) }
      : p,
  );

  it("renders the ops-edited LIVE prices (no rebuild): the packs change with the wire", async () => {
    getLiveCatalog.mockResolvedValue({ products: EDITED, live: true });
    const { joined, panelPacks } = await render({ balance: 50 });
    expect(panelPacks).toEqual(offeredCreditPacks({ products: EDITED }));
    expect(panelPacks).not.toEqual(offeredCreditPacks({ products: DEFAULT_CATALOG.products }));
    // And the live render carries NO cached-pricing note.
    expect(joined).not.toMatch(/cached pricing/i);
  });

  it("a catalog fetch FAILURE renders no packs — an error state with a retry, never the defaults", async () => {
    // getLiveCatalog fails OPEN (live:false, the compile-time products) — the page must not.
    getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: false });
    const { flat, classes, panelPacks } = await render({ balance: 50 });
    expect(panelPacks).toBeUndefined(); // no panel, so no default pack can be bought
    expect(flat).toContain("Packs unavailable");
    expect(flat).toContain("We couldn’t load the packs on sale right now.");
    expect(classes).toContain("state state--error");
    expect(flat).not.toMatch(/cached pricing/i); // nothing cached is shown, so nothing to disclose
    // The balance and the history still render beside it.
    expect(classes).toContain("cred-hero");
    expect(flat).toContain("Credit Movement & History");
  });
});

/**
 * UI-1 PAGE SPINE — the screen composes onto the shared primitives (page-head / stat-row /
 * section / panel--table / alert / state) instead of its own `dash-title` / `credits-section` /
 * `credits-state` / `credits-empty` names, and the history surface carries a real empty state
 * and a real error state rather than rendering nothing at all.
 */
describe("credits page — (g) UI-1 page spine + real empty/error states", () => {
  it("renders the spine primitives and none of the retired bespoke class names", async () => {
    const { classes } = await render({ balance: 50 });
    expect(classes).toContain("page-head");
    expect(classes).toContain("page-head__title");
    expect(classes).toContain("page-head__sub");
    expect(classes).toContain("cred-hero");
    expect(classes).toContain("cred-panel");
    // The page's info band is the DS alert. Only REAL mode draws one now (the Razorpay note) —
    // the mock-mode band was the "Mock payments only" disclaimer the owner ruled out (F35).
    payerServerConfig.mockReturnValue({
      apiBaseUrl: "http://localhost:3001",
      paymentsEnableReal: true,
      agencySupplyEnabled: false,
    });
    expect((await render({ balance: 50 })).classes).toContain("alert alert--info");
    for (const retired of [
      "dash-title",
      "dash-sub",
      "credits-section",
      "credits-state",
      "credits-alert",
      "credits-stats",
      "credits-table-card",
      "credits-nudge",
    ]) {
      expect(classes).not.toContain(retired);
    }
  });

  it("the low-balance nudge is the DS alert, not an ad-hoc Card + Badge", async () => {
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "8";
    const { classes, joined } = await render({ balance: 7 });
    expect(classes).toContain("alert alert--warning");
    expect(joined).toMatch(/running low/i); // intent of (a) preserved through the new markup
  });

  it("an EMPTY history renders a real empty state, never a missing panel", async () => {
    const { flat, classes } = await render({ balance: 50 });
    // The panel is present…
    expect(flat).toContain("Credit Movement & History");
    // …and says what is empty and what to do next.
    expect(flat).toContain("No recent credit movements");
    expect(classes).toContain("cred-empty");
  });

  it("a FAILED balance read gives the history panel an error state with a retry (no leak)", async () => {
    getDashboard.mockRejectedValueOnce(new Error("balance down: secret backend reason"));
    getCreditTopUps.mockResolvedValue([]);
    const tree = (await CreditsPage()) as ReactElement;
    const { text, classes } = collect(tree);
    const flat = text.join(" ").replace(/\s+/g, " ");
    expect(flat).toContain("Service unavailable"); // the page-level state
    expect(flat).toContain("History unavailable"); // the table's own state
    expect(classes).toContain("state state--error");
    // NO-LEAK: the thrown cause never reaches the screen.
    expect(flat).not.toContain("secret backend reason");
  });
});

describe("credits page — ledger degrade (C2 decoupling)", () => {
  it("a REJECTED getCreditTopUps (live fetch failure) never blanks the balance/packs", async () => {
    getDashboard.mockResolvedValue(dashboard(7, []));
    getCreditTopUps.mockRejectedValue(new Error("ledger unavailable"));
    const tree = (await CreditsPage()) as ReactElement;
    const { text } = collect(tree);
    const joined = text.join(" ");
    // The page still renders (balance section present), with an empty history — no crash.
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toMatch(/ledger unavailable/);
  });
});

/**
 * PR-D2 — presentation contracts that a markup change could silently drop:
 *  · the balance hero is the DS StatTile restyled by ONE class (not a forked tile), still inside
 *    the shared `stat-row` spine;
 *  · both ledgers are keyboard-reachable, labelled scroll regions over a no-wrap table — on a
 *    375px phone the history is wider than the screen and scrolls INSIDE its region, so without
 *    tabindex a keyboard user could never reach its right-hand columns.
 */
describe("credits page — (h) PR-D2 wallet hero + scrollable ledgers", () => {
  function byClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
    if (node === null || node === undefined || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      node.forEach((n) => byClass(n, cls, acc));
      return acc;
    }
    const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
    const cn = el.props?.className;
    if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
    if (el.props && "children" in el.props) byClass(el.props.children, cls, acc);
    return acc;
  }

  it("the balance renders in the designer hero", async () => {
    const { classes } = await render({ balance: 50 });
    expect(classes).toContain("cred-hero");
    expect(classes.some((c) => c.includes("cred-hero__num"))).toBe(true);
  });

  it("#2744: the hero holds the balance only — no unlock value, no average rate paid", async () => {
    setData({ balance: 50 });
    const tree = (await CreditsPage()) as ReactElement;
    const [hero] = byClass(tree, "cred-hero");
    expect(hero).toBeDefined();
    const text = collect(hero!).text.join(" ").replace(/\s+/g, " ");
    expect(text).toContain("50");
    expect(text).not.toMatch(/₹|unlock value|rate paid|\/ unlock/i);
    expect(byClass(hero!, "cred-hero__sub")).toHaveLength(0);
    expect(byClass(hero!, "cred-hero__stats")).toHaveLength(0);
  });

  it("the ledger is a focusable, labelled region wrapping a no-wrap table", async () => {
    setData({ balance: 50, unlocks: [unlock()], topUps: [topUp()] });
    const tree = (await CreditsPage()) as ReactElement;
    const wraps = byClass(tree, "tablewrap");
    expect(wraps).toHaveLength(1);
    const labels = wraps.map((w) => (w.props as Record<string, unknown>)["aria-label"]);
    expect(labels).toEqual(["Credit history"]);
    for (const w of wraps) {
      const props = w.props as Record<string, unknown>;
      expect(props.tabIndex).toBe(0);
      expect(props.role).toBe("region");
      const tables = byClass(w, "table");
      expect(tables).toHaveLength(1);
      expect(String((tables[0]!.props as { className?: string }).className)).toContain(
        "table--nowrap",
      );
    }
  });

  it("an EMPTY ledger renders no scroll region at all (nothing focusable with nothing in it)", async () => {
    setData({ balance: 50 });
    const tree = (await CreditsPage()) as ReactElement;
    expect(byClass(tree, "tablewrap")).toHaveLength(0);
  });
});

/**
 * #2085 — the packs handed to the panel carry the price each is CHARGED (`prices[]`): that is what
 * the tile and the confirm show and what the purchase sends back. With no `prices[]` (an older API)
 * the catalog price stands. (The API applies no offer to a pack today — charge-price.ts — so this
 * pins the wiring, not a pricing rule.)
 */
describe("credits page — #2085: the panel's packs are priced from prices[]", () => {
  const packRow = (tierCode: string, base: number, price: number) => ({
    productCode: "contact_unlock",
    tierCode,
    basePriceInr: base,
    priceInr: price,
    discountInr: base - price,
    offer: price < base ? { code: "DIWALI", endsAt: "2026-11-01T00:00:00.000Z" } : null,
  });

  it("each pack carries its charged price (and the list price only under an offer)", async () => {
    getLiveCatalog.mockResolvedValue({
      products: DEFAULT_CATALOG.products,
      prices: [
        packRow("pack_50", 2000, 2000),
        packRow("pack_200", 8000, 6000),
        packRow("pack_1000", 32000, 32000),
      ],
      live: true,
    });
    const { panelPacks } = await render({ balance: 50 });
    expect(panelPacks).toEqual([
      { code: "pack_50", priceInr: 2000, credits: 50 },
      // #2102 — the offered pack carries its deadline too, so its tile can state when the
      // struck price comes back.
      {
        code: "pack_200",
        priceInr: 6000,
        listPriceInr: 8000,
        offerEndsAt: "2026-11-01T00:00:00.000Z",
        credits: 200,
      },
      { code: "pack_1000", priceInr: 32000, credits: 1000 },
    ]);
  });

  it("no prices[] (an older API): the catalog prices", async () => {
    getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, prices: null, live: true });
    const { panelPacks } = await render({ balance: 50 });
    expect(panelPacks).toEqual([
      { code: "pack_50", priceInr: 2000, credits: 50 },
      { code: "pack_200", priceInr: 8000, credits: 200 },
      { code: "pack_1000", priceInr: 32000, credits: 1000 },
    ]);
  });
});

/**
 * #2744 item 6 — when the credits have run out, a notice says so and links to the packs. It reads
 * the balance the page already has (GET /payer/credits, via the dashboard read), it REPLACES the
 * "running low" nudge rather than stacking beside it, and an unread balance raises neither.
 */
describe("credits page — (i) #2744: an out-of-credits notice links to the packs", () => {
  /** Every element in the tree, in order (function components are not expanded). */
  function elements(
    node: ReactNode,
    acc: ReactElement<Record<string, unknown>>[] = [],
  ): ReactElement<Record<string, unknown>>[] {
    if (node === null || node === undefined || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      node.forEach((n) => elements(n, acc));
      return acc;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    acc.push(el);
    if (el.props && "children" in el.props) elements(el.props.children as ReactNode, acc);
    return acc;
  }
  async function page(balance: number) {
    setData({ balance });
    const tree = (await CreditsPage()) as ReactElement;
    const c = collect(tree);
    return { tree, flat: c.text.join(" ").replace(/\s+/g, " "), classes: c.classes };
  }

  it("zero credits: the notice, whose link lands on the packs section — and no 'running low'", async () => {
    const { tree, flat, classes } = await page(0);
    expect(flat).toContain("You are out of unlock credits");
    expect(classes).toContain("alert alert--danger");
    expect(flat).not.toMatch(/running low/i); // one notice, never both

    const all = elements(tree);
    const links = all.filter((e) => e.type === "a" && String(e.props.href).startsWith("#"));
    expect(links).toHaveLength(1);
    expect(collect(links[0]!).text.join(" ")).toContain("Buy credits");
    const targets = all.filter((e) => e.props.id === String(links[0]!.props.href).slice(1));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.type).toBe("section");
    // The packs section, and it clears the sticky header when the link scrolls to it.
    expect(String(targets[0]!.props.className).split(/\s+/)).toEqual(
      expect.arrayContaining(["cred-buy", "anchor-target"]),
    );
    expect(elements(targets[0]!).some((e) => "packs" in e.props)).toBe(true);
  });

  it("any credits left: no out-of-credits notice (a low balance keeps its own nudge)", async () => {
    process.env.PAYER_LOW_BALANCE_THRESHOLD = "8";
    for (const balance of [1, 7, 50]) {
      const { flat, classes } = await page(balance);
      expect(flat, String(balance)).not.toContain("out of unlock credits");
      expect(classes, String(balance)).not.toContain("alert alert--danger");
    }
    expect((await page(7)).flat).toMatch(/running low/i);
  });

  it("an unread balance is not an empty one: no notice", async () => {
    getDashboard.mockRejectedValueOnce(new Error("balance down"));
    getCreditTopUps.mockResolvedValue([]);
    const { text } = collect((await CreditsPage()) as ReactElement);
    expect(text.join(" ")).not.toContain("out of unlock credits");
  });
});
