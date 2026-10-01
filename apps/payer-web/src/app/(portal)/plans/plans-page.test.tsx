import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { Capacity } from "../../../lib/contracts";
import type { PayerSession } from "../../../lib/auth/types";

/**
 * /plans — Plans & capacity, the ONE home of Hiring capacity (2026-10-01).
 *
 * /capacity used to be a second page carrying the same tiles, the same capacity panel and the
 * same per-posting table; it is now a redirect to `/plans#hiring-capacity` (its own test). The
 * render cases its page test pinned are pinned HERE, on the page that renders them:
 *  - AT CAPACITY derives from the REAL enforcement-engine count (`activeVacancies >= allowance`),
 *    at / above / below the boundary, with the "live from the enforcement engine" note;
 *  - a capacity read FAILURE is the neutral, retryable error state — never the error detail;
 *  - the cached-pricing note shows only when the live catalog is unavailable, and the Hiring
 *    capacity panel still renders;
 *  - the per-posting table's empty state, the DS spine, and the faceless / no-oracle guardrails;
 *  - the Hiring capacity SECTION carries the anchor /capacity redirects to;
 *  - COMPANY-ONLY: an agent is sent to the dashboard before anything is read; the session gate
 *    runs first.
 * Rendered through React's server renderer; the two client children are inert markers.
 */

const EMPLOYER: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Manufacturing",
  role: "employer",
  status: "active",
};

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const getOrgRole = vi.fn<(s: unknown) => "owner" | "recruiter">();
const getCapacity = vi.fn<() => Promise<Capacity>>();
const getLiveCatalog = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("../../../lib/payer-api", () => ({ getCapacity: () => getCapacity() }));
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});
vi.mock("../../../components/retry-button", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return { RetryButton: () => React.createElement("button", { type: "button" }, "Retry") };
});
vi.mock("../capacity/capacity-panel", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return { CapacityPanel: () => React.createElement("div", { "data-stub": "capacity-panel" }) };
});

const { default: PlansPage, dynamic } = await import("./page");

function capacity(over: Partial<Capacity> = {}): Capacity {
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

async function html(): Promise<string> {
  return renderToStaticMarkup((await PlansPage()) as ReactElement);
}
/** Visible text, tags stripped and whitespace collapsed (entities as rendered). */
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
/** The markup of the element that opens with `openTag`, up to (not incl.) the next `until`. */
function between(markup: string, openTag: string, until: string): string {
  const start = markup.indexOf(openTag);
  expect(start, openTag).toBeGreaterThanOrEqual(0);
  const end = markup.indexOf(until, start + openTag.length);
  return markup.slice(start, end < 0 ? undefined : end);
}
/** Every `<a href>` in the markup, with its visible text. */
const links = (markup: string) =>
  Array.from(markup.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g), (m) => ({
    href: m[1]!,
    text: textOf(m[2]!).trim(),
  }));

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(EMPLOYER);
  getOrgRole.mockReset().mockReturnValue("owner");
  getCapacity.mockReset().mockResolvedValue(capacity());
  getLiveCatalog.mockReset().mockResolvedValue({ products: DEFAULT_CATALOG.products, live: true });
  redirect.mockClear();
});

describe("/plans — the gates run before any read", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("no session: the gate's own redirect, and nothing is read", async () => {
    requirePayer.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(PlansPage()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(getLiveCatalog).not.toHaveBeenCalled();
    expect(getCapacity).not.toHaveBeenCalled();
  });

  it("COMPANY-ONLY: an agent is sent to the dashboard before anything is read", async () => {
    requirePayer.mockResolvedValue({ ...EMPLOYER, role: "agent" });
    await expect(PlansPage()).rejects.toThrow("NEXT_REDIRECT /dashboard");
    expect(redirect).toHaveBeenCalledWith("/dashboard");
    expect(getLiveCatalog).not.toHaveBeenCalled();
    expect(getCapacity).not.toHaveBeenCalled();
  });

  it("a company is not redirected", async () => {
    await html();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("/plans — AT CAPACITY derives from the REAL count", () => {
  it("shows the At-capacity alert when activeVacancies === allowance (the boundary)", async () => {
    getCapacity.mockResolvedValue(capacity({ activeVacancies: 10, activeVacancyAllowance: 10 }));
    const out = await html();
    expect(textOf(out)).toContain("At capacity");
    expect(textOf(out)).toContain("will be paused until you add capacity");
    // The DS warning alert, not an ad-hoc card + badge.
    expect(out).toContain('class="alert alert--warning"');
  });

  it("shows it when activeVacancies EXCEEDS the allowance", async () => {
    getCapacity.mockResolvedValue(capacity({ activeVacancies: 12, activeVacancyAllowance: 10 }));
    expect(textOf(await html())).toContain("At capacity");
  });

  it("does NOT show it below the allowance", async () => {
    getCapacity.mockResolvedValue(capacity({ activeVacancies: 9, activeVacancyAllowance: 10 }));
    const out = await html();
    expect(textOf(out)).not.toContain("At capacity");
    expect(out).not.toContain("alert--warning");
  });

  it("the count shown is the live active_plan_count (4 / 10), with the enforcement-engine note", async () => {
    getCapacity.mockResolvedValue(capacity({ activeVacancies: 4, activeVacancyAllowance: 10 }));
    const text = textOf(await html());
    expect(text).toContain("4 / 10");
    expect(text.toLowerCase()).toContain("live from the enforcement engine");
  });
});

describe("/plans — degraded reads", () => {
  it("a failed capacity read is the neutral, retryable DS error state — never the detail", async () => {
    getCapacity.mockRejectedValue(new Error("payer_id forbidden: secret backend reason"));
    const out = await html();
    expect(out).toContain('class="state state--error"');
    expect(textOf(out)).toContain("Service unavailable");
    expect(out).toContain(">Retry</button>");
    expect(out).not.toContain("secret backend reason");
    expect(out).not.toMatch(/\bforbidden\b/i);
  });

  it("an unavailable live catalog shows the cached-pricing note — and the capacity panel still renders", async () => {
    getLiveCatalog.mockResolvedValue({ products: DEFAULT_CATALOG.products, live: false });
    const out = await html();
    expect(textOf(out)).toMatch(/cached pricing/i);
    expect(out).toContain('data-stub="capacity-panel"');
  });

  it("a live catalog shows no cached-pricing note", async () => {
    expect(textOf(await html())).not.toMatch(/cached pricing/i);
  });
});

describe("/plans — Hiring capacity is ONE section, the target of /capacity", () => {
  it("the section carries the anchor id and holds the capacity panel", async () => {
    const out = await html();
    const section = between(out, '<section class="section" id="hiring-capacity">', "</section>");
    expect(textOf(section)).toContain("Hiring capacity");
    expect(section).toContain('data-stub="capacity-panel"');
    // …exactly one capacity panel on the page.
    expect(out.match(/data-stub="capacity-panel"/g)).toHaveLength(1);
  });
});

describe("/plans — the page spine and the per-posting table", () => {
  it("renders the DS spine (a top-level head with no back link) and none of the retired names", async () => {
    const out = await html();
    for (const cls of [
      'class="page-head"',
      'class="page-head__title"',
      'class="page-head__sub"',
      'class="stat-row stat-row--kpi"',
      'class="panel panel--table"',
      'class="alert alert--info"',
    ]) {
      expect(out, cls).toContain(cls);
    }
    expect(out).not.toContain("page-back");
    for (const retired of ["capacity-page", "capacity-section", "capacity-state", "capacity-empty"]) {
      expect(out, retired).not.toContain(retired);
    }
  });

  it("NO posting rows is a real empty state — with no second New posting (the page has one)", async () => {
    const out = await html();
    const table = between(out, '<section class="panel panel--table">', "</section>");
    expect(textOf(table)).toContain("No postings yet");
    expect(textOf(table)).toContain("You haven’t published a posting yet");
    expect(links(table)).toEqual([]);
    // The page's ONE "New posting" (Posting plans), to the company form.
    expect(links(out).filter((l) => l.text === "New posting")).toEqual([
      { href: "/postings/new", text: "New posting" },
    ]);
  });

  it("each row's role opens that posting's applicants; the table stays faceless", async () => {
    getCapacity.mockResolvedValue(
      capacity({
        activeVacancies: 1,
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
    const out = await html();
    expect(links(out)).toContainEqual({
      href: "/postings/bbbb2222-0000-4000-8000-000000000001/applicants",
      text: "CNC Machinist",
    });
    expect(textOf(out)).not.toMatch(/phone|\bemail\b|\+?\d{7,}/i);
  });
});
