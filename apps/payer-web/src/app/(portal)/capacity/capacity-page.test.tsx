import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { Capacity } from "../../../lib/contracts";
import type { PayerSession } from "../../../lib/auth/types";

/**
 * CAPACITY PAGE render tests — the AT-CAPACITY banner derivation (A2).
 *
 * `atCapacity` is page logic: `capacity.activeVacancies >= capacity.activeVacancyAllowance`,
 * where `activeVacancies` is the REAL enforcement-engine count (active_plan_count), NOT the
 * mock posting rows. These tests pin the derivation at/above/below the allowance, plus:
 *  - the "live from the enforcement engine" note (the count drives the banner, not mock rows),
 *  - a load FAILURE degrades to the neutral "Service unavailable" + a RetryButton (no leak),
 *  - GUARDRAILS: no role-named/"forbidden" oracle string; faceless (no PII-looking text).
 *
 * Env is node (no DOM); render the async Server Component to an element tree and walk it.
 */

const EMPLOYER: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Manufacturing",
  role: "employer",
  status: "active",
};

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const getCapacity = vi.fn<() => Promise<Capacity>>();
const hiringCapacityTiers = vi.fn(() => [
  { code: "growth", priceInr: 4999, maxActiveVacancies: 10 },
]);
// The LIVE catalog seam (D-6): default = live (no cached-pricing note); a dedicated test
// flips it to the fallback. The tier VALUES stay pinned by the pricing-config mock above.
const getLiveCatalog = vi.fn(async () => ({ products: [], live: true }));

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/payer-api", () => ({ getCapacity: () => getCapacity() }));
vi.mock("../../../lib/pricing-config", () => ({ hiringCapacityTiers: () => hiringCapacityTiers() }));
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
// next/link → plain anchor; the child client components → inert markers (unit-tested elsewhere).
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
const RetryButtonStub = () => null;
const CapacityPanelStub = () => null;
vi.mock("../../../components/retry-button", () => ({ RetryButton: RetryButtonStub }));
vi.mock("./capacity-panel", () => ({ CapacityPanel: CapacityPanelStub }));

const { default: CapacityPage } = await import("./page");

interface Collected {
  types: string[];
  components: unknown[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "string") {
    acc.types.push(el.type);
    if (el.props && "children" in el.props) walk(el.props.children, acc);
    return;
  }
  // Function component: record it by reference (the RetryButton/CapacityPanel assertions
  // collect by identity), then EXPAND it ONE LEVEL by invoking it with its props so the DS
  // primitives' text rendered via non-children props (StatTile's label/value/delta, etc.)
  // is reachable. The DS primitives + the test stubs are all hookless/presentational, so a
  // plain call is safe; a stub that returns null simply contributes nothing.
  acc.components.push(el.type);
  const Fn = el.type as (props: Record<string, unknown>) => ReactNode;
  let rendered: ReactNode = null;
  try {
    rendered = Fn((el.props ?? {}) as Record<string, unknown>);
  } catch {
    rendered = (el.props as { children?: ReactNode } | null)?.children ?? null;
  }
  walk(rendered, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { types: [], components: [], text: [] };
  walk(tree, acc);
  return acc;
}

function capacity(over: Partial<Capacity>): Capacity {
  return {
    payerId: EMPLOYER.payerId,
    activeVacancies: 0,
    activeVacancyAllowance: 10,
    applicantQuotaTotal: 0,
    applicantQuotaUsed: 0,
    postings: [],
    ...over,
  };
}

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(EMPLOYER);
  getCapacity.mockReset().mockResolvedValue(capacity({}));
  hiringCapacityTiers.mockClear();
  getLiveCatalog.mockClear().mockResolvedValue({ products: [], live: true });
});

describe("capacity page — AT-CAPACITY banner derives from the REAL count (A2)", () => {
  it("shows the At-capacity banner when activeVacancies === allowance (at the boundary)", async () => {
    getCapacity.mockResolvedValueOnce(capacity({ activeVacancies: 10, activeVacancyAllowance: 10 }));
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).toContain("At capacity");
    expect(joined).toContain("will be paused until you add capacity");
  });

  it("shows the At-capacity banner when activeVacancies EXCEEDS the allowance", async () => {
    getCapacity.mockResolvedValueOnce(capacity({ activeVacancies: 12, activeVacancyAllowance: 10 }));
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).toContain("At capacity");
  });

  it("does NOT show the banner when activeVacancies is BELOW the allowance", async () => {
    getCapacity.mockResolvedValueOnce(capacity({ activeVacancies: 9, activeVacancyAllowance: 10 }));
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).not.toContain("At capacity");
  });

  it("the count shown is the live active_plan_count (4/10), with the enforcement-engine note", async () => {
    getCapacity.mockResolvedValueOnce(capacity({ activeVacancies: 4, activeVacancyAllowance: 10 }));
    const joined = collect(await CapacityPage()).text.join(" ");
    // The big stat is "<count> / <allowance>".
    expect(joined.replace(/\s+/g, " ")).toContain("4 / 10");
    expect(joined).not.toContain("At capacity");
    // The page states the count is LIVE from the enforcement engine (drives the banner).
    expect(joined.toLowerCase()).toContain("live from the enforcement engine");
  });
});

describe("capacity page — load failure degrades neutrally (no leak)", () => {
  it("renders the neutral Service-unavailable fallback + a RetryButton, never the error detail", async () => {
    getCapacity.mockRejectedValueOnce(new Error("payer_id forbidden: secret backend reason"));
    const { text, components } = collect(await CapacityPage());
    const joined = text.join(" ");
    expect(joined).toContain("Service unavailable");
    expect(components).toContain(RetryButtonStub);
    // NO-LEAK: the thrown error message (which carries a deny cause) never reaches the screen.
    expect(joined).not.toContain("secret backend reason");
    expect(joined).not.toContain("forbidden");
  });
});

describe("capacity page — D-6 cached-pricing fallback (live catalog unavailable)", () => {
  it("renders the subtle cached-pricing note + the tier panel (never a blank pricing section)", async () => {
    getLiveCatalog.mockResolvedValueOnce({ products: [], live: false });
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).toMatch(/cached pricing/i);
    // The pricing section still renders (fallback tiers, not a blank page).
    expect(joined).toContain("Add capacity");
  });

  it("does NOT render the cached-pricing note when the catalog is live", async () => {
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).not.toMatch(/cached pricing/i);
  });
});

describe("capacity page — guardrails NOT regressed (no-oracle + faceless)", () => {
  it("carries no role-named / 'forbidden' oracle string in the rendered states", async () => {
    getCapacity.mockResolvedValueOnce(capacity({ activeVacancies: 10, activeVacancyAllowance: 10 }));
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).not.toMatch(/\bforbidden\b/i);
  });

  it("is faceless — no PII-looking text (name/phone/email/employer-of-a-worker/address)", async () => {
    getCapacity.mockResolvedValueOnce(
      capacity({
        activeVacancies: 1,
        activeVacancyAllowance: 10,
        postings: [
          {
            postingId: "bbbb2222-0000-4000-8000-000000000001",
            roleTitle: "CNC Machinist",
            status: "open",
            vacancyBand: "6-20",
            applicantsUsed: 2,
            applicantQuota: 10,
          },
        ],
      }),
    );
    const joined = collect(await CapacityPage()).text.join(" ");
    expect(joined).not.toMatch(/phone|\bemail\b|\+?\d{7,}/i);
  });
});
