import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What each list page hands its filter panel (final sweep AW-08 and its reviews), rendered with
 * the REAL filter bars.
 *
 * The panel re-syncs its open state — and each bar its fields — when the page's filter SET
 * changes, without remounting (url-state.behaviour.test.tsx drives that render by render). So the
 * contract here is the set itself: every filter the page reads from the URL is in it (a missing
 * one would neither count nor re-open the panel), and nothing that is not a filter is (a cursor
 * would re-sync — and so re-open or reset — the panel on every page turn).
 */
const stub = vi.hoisted(() => ({
  events: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));
vi.mock("../../lib/auth", () => ({
  requireCapability: async (capability: string) => ({
    adminId: "a-1",
    role: "super_admin",
    capabilities: [capability, "read_entities", "read_events", "read_identity", "read_ai_traces"],
  }),
}));
vi.mock("../../lib/admin-http", () => ({ isAdminRequestError: () => false }));
vi.mock("../../lib/events", () => ({
  listEvents: async () => ({ events: stub.events, nextCursor: null }),
}));
vi.mock("../../lib/entities", () => ({
  listPayers: async () => ({ items: [], nextCursor: null }),
  listJobPostings: async () => ({ items: [], nextCursor: null }),
  listWorkers: async () => ({ items: [], nextCursor: null }),
}));
vi.mock("../../lib/ai-traces", () => ({
  listAiTraces: async () => ({ items: [], nextCursor: null }),
}));

const { default: EventsPage } = await import("./events/page");
const { default: CompaniesPage } = await import("./companies/page");
const { default: AgenciesPage } = await import("./agencies/page");
const { default: JobsPage } = await import("./jobs/page");
const { default: AiCallsPage } = await import("./ai-calls/page");
const { default: WorkersPage } = await import("./workers/page");
const { FilterPanel, filterSetKey } = await import("../../components/filter-panel");

const CORRELATION = "5eeded00-00c0-4a00-8000-0000000000c0";
const UUID = "5eeded00-0002-4a00-8000-000000000002";
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

/** The filter set the page hands its panel — what the panel counts and re-syncs on. */
async function filterSet(page: Page, sp: Record<string, string> = {}) {
  const el = find(await tree(page, sp), FilterPanel);
  expect(el, "the page renders a FilterPanel").not.toBeNull();
  return (el!.props as { filters: Record<string, string | boolean | undefined> }).filters;
}
const syncKey = async (page: Page, sp: Record<string, string> = {}) =>
  filterSetKey(await filterSet(page, sp));

/** The value attribute of the input whose placeholder is `placeholder`. */
const inputValue = (out: string, placeholder: string) => {
  const tag = (out.match(/<input[^>]*>/g) ?? []).find((t) =>
    t.includes(`placeholder="${placeholder}"`),
  );
  expect(tag, placeholder).toBeTruthy();
  return /value="([^"]*)"/.exec(tag!)?.[1] ?? "";
};

/** Each page, one filter of each kind it reads, and how many that is. */
const PAGES: Array<[string, Page, Record<string, string>, number]> = [
  [
    "events",
    EventsPage as Page,
    {
      eventName: "worker.registered",
      actorType: "system",
      subjectType: "worker",
      correlationId: CORRELATION,
    },
    4,
  ],
  ["companies", CompaniesPage as Page, { status: "active" }, 1],
  ["agencies", AgenciesPage as Page, { status: "active" }, 1],
  ["jobs", JobsPage as Page, { status: "open", verificationStatus: "verified", payerId: UUID }, 3],
  [
    "ai-calls",
    AiCallsPage as Page,
    { taskType: "profiling_chat_turn", success: "false", workerId: UUID },
    3,
  ],
  ["workers", WorkersPage as Page, { status: "active", pendingDeletion: "true" }, 2],
];

describe("/events — following a row's correlation-id link (review M1)", () => {
  it("the link lands on a NEW filter set carrying the correlation id — the panel re-syncs on it", async () => {
    const before = await syncKey(EventsPage as Page);
    const after = await syncKey(EventsPage as Page, { correlationId: CORRELATION });
    expect(after).not.toBe(before);
    expect(after).toContain(CORRELATION);
  });

  it("…which is open, counts the filter, and shows the correlation id in its field", async () => {
    const out = await html(EventsPage as Page, { correlationId: CORRELATION });
    expect(out).toContain('data-open="true"');
    expect(out).toContain(">Filters (1)</button>");
    expect(inputValue(out, "full UUID")).toBe(CORRELATION);
  });

  it("the link the row offers is the URL this test opens", async () => {
    expect(await html(EventsPage as Page)).toContain(`href="/events?correlationId=${CORRELATION}"`);
  });
});

describe.each(PAGES)(
  "/%s — the filter set it hands the panel (review L3)",
  (_name, page, all, count) => {
    it("closed with no filter", async () => {
      const none = await html(page);
      expect(none).toContain('data-open="false"');
      expect(none).toContain(">Filters</button>");
    });

    it(`every filter it reads counts: Filters (${count})`, async () => {
      const out = await html(page, all);
      expect(out).toContain('data-open="true"');
      expect(out).toContain(`>Filters (${count})</button>`);
    });

    it("each filter on its own counts as one, and is its own filter set", async () => {
      const empty = await syncKey(page);
      for (const [name, value] of Object.entries(all)) {
        const out = await html(page, { [name]: value });
        expect(out, name).toContain(">Filters (1)</button>");
        expect(await syncKey(page, { [name]: value }), name).not.toBe(empty);
      }
    });

    it("a page cursor is not a filter: the set — and so the panel — is unchanged by it", async () => {
      expect(await filterSet(page, { ...all, cursor: "c1" })).toEqual(await filterSet(page, all));
      expect(await syncKey(page, { ...all, cursor: "c1" })).toBe(await syncKey(page, all));
      expect(await syncKey(page, { cursor: "c1" })).toBe(await syncKey(page));
    });
  },
);

describe("the fields show the URL's values (a fresh render)", () => {
  it("/events: the event name, and the correlation id", async () => {
    const out = await html(EventsPage as Page, {
      eventName: "worker.registered",
      correlationId: CORRELATION,
    });
    expect(inputValue(out, "worker.profile_confirmed")).toBe("worker.registered");
    expect(inputValue(out, "full UUID")).toBe(CORRELATION);
  });

  it("/jobs: the customer id", async () => {
    expect(inputValue(await html(JobsPage as Page, { payerId: UUID }), "full UUID")).toBe(UUID);
  });
});
