import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Dashboard RENDERS around its partial failures and its links into the log.
 *
 *  - The summary read (AI spend + volume) failing left prose alone — "Reload to try again" —
 *    where the same partial failure on a detail page offers a Retry (sweep AW-15).
 *  - "View events" appeared twice, both to `/events`: on the cap-breach attention item and in
 *    the Recent activity head (AW-16). One target, one link.
 *
 * The four data seams are mocked; the page and its components are real.
 */
const stub = vi.hoisted(() => ({
  metrics: null as unknown,
  /** The window each read was asked for, in call order (#2572). */
  metricsWindows: [] as (number | undefined)[],
  summaryWindows: [] as (number | undefined)[],
}));

vi.mock("../../lib/auth", () => ({
  requireSession: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: ["read_events", "read_entities"],
  }),
}));

vi.mock("../../lib/events", () => ({
  getMetrics: async (windowDays?: number) => {
    stub.metricsWindows.push(windowDays);
    return stub.metrics;
  },
  getHealth: async () => ({
    status: "ok",
    service: "api",
    environment: "production",
    timestamp: "2026-10-01T09:00:00.000Z",
    checks: { db: "up" },
  }),
  listEvents: async () => ({ events: [], nextCursor: null }),
}));

// The summary read FAILS throughout: its failure state is what this file asserts, and the two
// panels it would otherwise feed have their own render tests.
vi.mock("../../lib/dashboard", () => ({
  getDashboardSummary: async (windowDays?: number) => {
    stub.summaryWindows.push(windowDays);
    throw new TypeError("fetch failed");
  },
}));

const { default: DashboardPage } = await import("./page");

const metrics = (breaches: { key: string; count: number }[]) => ({
  window_days: 7,
  by_event_name: [],
  by_day: [],
  by_actor_type: [],
  funnel: [],
  breaches,
  k_anon_floor: 5,
});

beforeEach(() => {
  stub.metrics = metrics([]);
  stub.metricsWindows = [];
  stub.summaryWindows = [];
});

const render = async (searchParams: Record<string, string | undefined> = {}) =>
  renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve(searchParams) }));

describe("the summary's partial failure", () => {
  it("offers a Retry of this page — and the copy no longer also says reload", async () => {
    const out = await render();
    expect(out).toContain("AI spend and volume could not be loaded");
    expect(out).toMatch(/href="\/">(<i [^>]*><\/i>)?Retry<\/a>/);
    expect(out).not.toMatch(/reload/i);
  });

  it("repeats the address as it was asked for", async () => {
    const out = await render({ denied: "manage_admins" });
    expect(out).toMatch(/href="\/\?denied=manage_admins">(<i [^>]*><\/i>)?Retry<\/a>/);
  });
});

describe("one link to the whole events log", () => {
  const eventsLinks = (out: string) => out.split('href="/events"').length - 1;

  it("with one kind of cap tripped, the attention item links that event — the log is linked once", async () => {
    stub.metrics = metrics([
      { key: "ai.spend_cap_exceeded", count: 2 },
      { key: "unlock.cap_exceeded", count: 0 },
    ]);
    const out = await render();
    expect(out).toContain("2 cap breaches");
    expect(out).toContain('href="/events?eventName=ai.spend_cap_exceeded"');
    expect(eventsLinks(out)).toBe(1);
    // "View events" names the whole log, once; the filtered link is named for its slice.
    expect(out.split(">View events<").length - 1).toBe(1);
    expect(out).toContain(">View these breaches<");
  });

  it("with several kinds tripped, the attention item carries no second link to the log", async () => {
    stub.metrics = metrics([
      { key: "ai.spend_cap_exceeded", count: 2 },
      { key: "unlock.cap_exceeded", count: 1 },
    ]);
    const out = await render();
    expect(out).toContain("3 cap breaches");
    expect(eventsLinks(out)).toBe(1);
    expect(out.split(">View events<").length - 1).toBe(1);
  });
});

describe("the 7 / 30 / 90-day window (#2572)", () => {
  /** The segment the control marks as chosen. */
  const current = (out: string) =>
    /<a [^>]*class="seg__option"[^>]*aria-current="page"[^>]*>([^<]*)<\/a>/.exec(out)?.[1] ??
    /<a [^>]*aria-current="page"[^>]*class="seg__option"[^>]*>([^<]*)<\/a>/.exec(out)?.[1];

  it("defaults to 30 days — both APIs' own default, so `/` reads the same numbers", async () => {
    const out = await render();
    expect(current(out)).toBe("30 days");
    expect(stub.metricsWindows).toEqual([30]);
    expect(stub.summaryWindows).toEqual([30]);
  });

  it("sends the chosen window to BOTH reads", async () => {
    const out = await render({ window: "90" });
    expect(current(out)).toBe("90 days");
    expect(stub.metricsWindows).toEqual([90]);
    expect(stub.summaryWindows).toEqual([90]);
  });

  it("ignores a window it does not offer, rather than forwarding it", async () => {
    await render({ window: "13" });
    expect(stub.metricsWindows).toEqual([30]);
  });

  it("replaces the 'Window' tile — the period is a choice, not a figure", async () => {
    const out = await render();
    expect(out).toContain('aria-label="Reporting window"');
    expect(out).not.toMatch(/stat__label">Window</);
    expect(out).toContain('href="/?window=7"');
    expect(out).toContain('href="/?window=90"');
  });

  it("keeps the window and the denied notice in Retry", async () => {
    const out = await render({ window: "7", denied: "manage_admins" });
    expect(out).toMatch(/href="\/\?window=7&amp;denied=manage_admins">(<i [^>]*><\/i>)?Retry<\/a>/);
  });
});

describe("a simulated dependency is announced once (#2572)", () => {
  it("the health panel no longer repeats the mock explanation", async () => {
    const out = await render();
    expect(out).not.toContain("means that dependency is simulated");
  });
});
