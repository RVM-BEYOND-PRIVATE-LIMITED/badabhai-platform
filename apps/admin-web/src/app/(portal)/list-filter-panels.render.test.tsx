import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The list pages' filter panels (final sweep AW-08 and its review): events, companies and
 * agencies, with their REAL filter bars — ai-calls, jobs and workers are covered in their own
 * page tests.
 *
 * Review M1: the panel's open state (and the filter bar's field values inside it) were decided
 * once, at mount, and Next keeps client state across a search-params-only navigation. A row's
 * correlation-id link on /events therefore left a phone's panel closed over a filtered list, and
 * left the Correlation id field empty at every width — so Apply dropped the filter. The panel is
 * now keyed on the filter values the page read from the URL; these pin that each page hands it
 * those values, and what a fresh mount for them shows.
 */
const stub = vi.hoisted(() => ({
  events: [] as unknown[],
  payers: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));
vi.mock("../../lib/auth", () => ({
  requireCapability: async (capability: string) => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: [capability, "read_entities", "read_events", "read_identity"],
  }),
}));
vi.mock("../../lib/events", () => ({
  listEvents: async () => ({ events: stub.events, nextCursor: null }),
}));
vi.mock("../../lib/entities", () => ({
  listPayers: async () => ({ items: stub.payers, nextCursor: null }),
}));

const { default: EventsPage } = await import("./events/page");
const { default: CompaniesPage } = await import("./companies/page");
const { default: AgenciesPage } = await import("./agencies/page");
const { FilterPanel } = await import("../../components/filter-panel");

const CORRELATION = "5eeded00-00c0-4a00-8000-0000000000c0";
const EVENT = {
  id: "5eeded00-0005-4a00-8000-000000000005",
  event_name: "worker.registered",
  event_version: 1,
  actor_type: "system",
  actor_id: null,
  subject_type: "worker",
  subject_id: "5eeded00-0001-4a00-8000-000000000001",
  occurred_at: "2026-10-01T09:00:00.000Z",
  correlation_id: CORRELATION,
  causation_id: null,
};

beforeEach(() => {
  stub.events = [EVENT];
  stub.payers = [];
});

type Page = (p: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const tree = (page: Page, sp: Record<string, string> = {}) =>
  page({ searchParams: Promise.resolve(sp) });
const html = async (page: Page, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await tree(page, sp));

/** The first element of `type` anywhere in an element tree, props included (a header's `filters`). */
function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  for (const value of Object.values(node.props as Record<string, unknown>)) {
    const hit = find(value as ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

/** The key the page's panel mounts its body under — what decides whether a navigation remounts it. */
async function panelKey(page: Page, sp: Record<string, string> = {}): Promise<string | null> {
  const el = find(await tree(page, sp), FilterPanel);
  expect(el, "the page renders a FilterPanel").not.toBeNull();
  return (FilterPanel(el!.props as Parameters<typeof FilterPanel>[0]) as ReactElement).key;
}

/** The value attribute of the input whose placeholder is `placeholder`. */
const inputValue = (out: string, placeholder: string) => {
  const tag = (out.match(/<input[^>]*>/g) ?? []).find((t) =>
    t.includes(`placeholder="${placeholder}"`),
  );
  expect(tag, placeholder).toBeTruthy();
  return /value="([^"]*)"/.exec(tag!)?.[1] ?? "";
};

describe("/events — following a row's correlation-id link (review M1)", () => {
  it("the link lands on a NEW panel: its key carries the correlation id, so it remounts", async () => {
    const before = await panelKey(EventsPage);
    const after = await panelKey(EventsPage, { correlationId: CORRELATION });
    expect(after).not.toBe(before);
    expect(after).toContain(CORRELATION);
  });

  it("…which is open, counts the filter, and shows the correlation id in its field", async () => {
    const out = await html(EventsPage, { correlationId: CORRELATION });
    expect(out).toContain('data-open="true"');
    expect(out).toContain(">Filters (1)</button>");
    expect(inputValue(out, "full UUID")).toBe(CORRELATION);
  });

  it("the link the row offers is the URL this test opens", async () => {
    expect(await html(EventsPage)).toContain(`href="/events?correlationId=${CORRELATION}"`);
  });
});

describe("activeCount on the pages without a test of their own (review L3)", () => {
  it("/events: closed with no filter; each filter counts once", async () => {
    const none = await html(EventsPage);
    expect(none).toContain('data-open="false"');
    expect(none).toContain(">Filters</button>");
    const two = await html(EventsPage, { eventName: "worker.registered", actorType: "system" });
    expect(two).toContain('data-open="true"');
    expect(two).toContain(">Filters (2)</button>");
    expect(inputValue(two, "worker.profile_confirmed")).toBe("worker.registered");
  });

  it.each([
    ["companies", CompaniesPage],
    ["agencies", AgenciesPage],
  ] as const)("/%s: closed with no status, open with Filters (1) for one", async (_name, page) => {
    const none = await html(page as Page);
    expect(none).toContain('data-open="false"');
    expect(none).toContain(">Filters</button>");
    const one = await html(page as Page, { status: "active" });
    expect(one).toContain('data-open="true"');
    expect(one).toContain(">Filters (1)</button>");
  });

  it.each([
    ["companies", CompaniesPage],
    ["agencies", AgenciesPage],
  ] as const)("/%s: a new status is a new panel", async (_name, page) => {
    expect(await panelKey(page as Page, { status: "active" })).not.toBe(
      await panelKey(page as Page, { status: "suspended" }),
    );
  });
});
