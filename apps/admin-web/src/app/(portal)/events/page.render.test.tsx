import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Events list RENDERS when its read fails.
 *
 * A REFUSED read and an UNAVAILABLE one are different screens (sweep AW-05): an outage with no
 * filter in the address read "The server rejected these filters", sending the operator to fix a
 * correlation id they had never typed. And a failure past page one keeps every filter on both of
 * its recoveries (AW-06): the head's "Clear filters" was the only exit, and it drops them.
 */
const stub = vi.hoisted(() => {
  /** Stands in for `AdminRequestError`, whose `status` is what separates the two failures. */
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    failure: null as unknown,
    page: { events: [] as unknown[], nextCursor: null as string | null },
    /** What the page asked the API for, last. */
    asked: null as Record<string, unknown> | null,
    /** The event-name suggestions' read: a list, or a failure to throw. */
    names: ["profile.confirmed", "worker.created"] as string[] | Error,
    /** What the page handed its filter bar, last. */
    barProps: null as Record<string, unknown> | null,
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: ["read_events"],
  }),
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../lib/events", () => ({
  listEvents: async (filters: Record<string, unknown>) => {
    stub.asked = filters;
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
  listRecentEventNames: async () => {
    if (stub.names instanceof Error) throw stub.names;
    return stub.names;
  },
}));

// `useRouter` needs an app-router context this renderer does not provide; the stand-in keeps
// what the page handed the bar.
vi.mock("./filter-bar", () => ({
  EventFilterBar: (props: Record<string, unknown>) => {
    stub.barProps = props;
    return null;
  },
}));

const { default: EventsPage } = await import("./page");

beforeEach(() => {
  stub.failure = null;
  stub.page = { events: [], nextCursor: null };
  stub.asked = null;
  stub.names = ["profile.confirmed", "worker.created"];
  stub.barProps = null;
});

const render = async (searchParams: Record<string, string | undefined> = {}) =>
  renderToStaticMarkup(await EventsPage({ searchParams: Promise.resolve(searchParams) }));

describe("an outage is ours, and says so", () => {
  it("with no filter, it never claims a filter was rejected", async () => {
    stub.failure = new TypeError("fetch failed");
    const out = await render();
    expect(out).toContain("Events are unavailable");
    expect(out).toContain("a fault on our side");
    expect(out).toContain("Nothing was fetched.");
    expect(out).not.toContain("rejected");
    expect(out).toMatch(/href="\/events">(<i [^>]*><\/i>)?Retry<\/a>/);
  });

  it("a 500 is an outage too, even with a filter set", async () => {
    stub.failure = new stub.RequestError(500);
    const out = await render({ eventName: "worker.registered" });
    expect(out).toContain("Events are unavailable");
    expect(out).not.toContain("rejected");
  });

  it("filtered and past page one: Retry and the first page, both keeping every filter", async () => {
    stub.failure = new stub.RequestError(502);
    const out = await render({ eventName: "worker.registered", actorType: "worker", cursor: "c2" });
    expect(out).toMatch(
      /href="\/events\?eventName=worker\.registered&amp;actorType=worker&amp;cursor=c2">(<i [^>]*><\/i>)?Retry<\/a>/,
    );
    expect(out).toMatch(
      /href="\/events\?eventName=worker\.registered&amp;actorType=worker">(<i [^>]*><\/i>)?Back to the first page<\/a>/,
    );
    // The head's Clear filters is still the one clear on the screen.
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });
});

describe("a 400 is the operator's address, and says so", () => {
  it("with a filter set: the refusal copy, and no Retry that could only repeat it", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ correlationId: "abc" });
    expect(out).toContain("The server rejected these filters");
    expect(out).toContain("A correlation id must be a full UUID");
    expect(out).toContain("That filter combination was rejected.");
    expect(out).not.toContain("Events are unavailable");
    expect(out).not.toContain(">Retry<");
    expect(out).not.toContain("Back to the first page");
  });

  it("with a filter set, its way out is Clear filters — in the refusal, once on the screen", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ correlationId: "abc" });
    const state = out.slice(out.indexOf('class="state state--error"'));
    expect(state).toMatch(/href="\/events">(<i [^>]*><\/i>)?Clear filters(?:<span class="nav-pending" aria-hidden="true"><\/span>)?<\/a>/);
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });

  it("filtered and past page one: Clear filters — never a first page that keeps the refused filter", async () => {
    // The API refuses a page cursor only when it is longer than any it issues, so with a filter
    // set the FILTER was refused, and its first page would be refused again.
    stub.failure = new stub.RequestError(400);
    // A subject type the API refuses: it accepts any text up to 64 characters, so only a longer
    // one can be the refused filter (a valid one beside a cursor leaves the CURSOR refused).
    const out = await render({ subjectType: "x".repeat(65), cursor: "c2" });
    expect(out).not.toContain("Back to the first page");
    expect(out).not.toContain(">Retry<");
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });

  it("with NOTHING in the address: cannot be the operator's — an outage, with Retry", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render();
    expect(out).toContain("Events are unavailable");
    expect(out).not.toContain("The server rejected");
    expect(out).toMatch(/href="\/events">(<i [^>]*><\/i>)?Retry<\/a>/);
  });

  it("on a cursor ALONE: names the cursor — there is no correlation id to correct", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ cursor: "stale" });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain("correlation id");
    expect(out).not.toContain("filter combination");
    expect(out).toMatch(/href="\/events">(<i [^>]*><\/i>)?Back to the first page<\/a>/);
  });
});

/** Free text within the API's bounds and a real correlation id are never the refused part (delta review of #2095). */
describe("valid filters with a refused cursor get the cursor's copy", () => {
  it("an event name, an actor type and a correlation id beside an over-long cursor: the page was refused", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({
      eventName: "worker.registered",
      actorType: "worker",
      correlationId: "6155050c-c91b-4c6e-96a7-8da023f1d2d2",
      cursor: "x".repeat(300),
    });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain("The server rejected these filters");
    const state = out.slice(out.indexOf('class="state state--error"'));
    const first = /href="([^"]*)"><i [^>]*><\/i>Back to the first page<\/a>/.exec(state)?.[1] ?? "";
    expect(first).toContain("eventName=worker.registered");
    expect(first).not.toContain("cursor=");
    expect(state).not.toContain(">Clear filters<");
  });

  it("free text past the API's bound is still the refused part", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ actorType: "x".repeat(65), cursor: "x".repeat(300) });
    expect(out).toContain("The server rejected these filters");
  });
});

/**
 * THE DATE RANGE (A4, #2574). The API takes `occurredFrom` / `occurredTo` as instants and compares
 * them inclusively; the address holds two IST days, so "1 Nov to 3 Nov" reaches the API as the
 * first instant of 1 Nov IST and the last of 3 Nov IST.
 */
describe("the date range", () => {
  const EVENT = {
    id: "5eeded00-0005-4a00-8000-000000000005",
    event_name: "worker.registered",
    event_version: 1,
    actor_type: "system",
    actor_id: null,
    subject_type: "worker",
    subject_id: "5eeded00-0001-4a00-8000-000000000001",
    occurred_at: "2026-11-02T09:00:00.000Z",
    correlation_id: "5eeded00-00c0-4a00-8000-0000000000c0",
    causation_id: null,
  };

  it("asks the API for the whole of both IST days", async () => {
    await render({ occurredFrom: "2026-11-01", occurredTo: "2026-11-03" });
    expect(stub.asked).toMatchObject({
      occurredFrom: "2026-11-01T00:00:00.000+05:30",
      occurredTo: "2026-11-03T23:59:59.999+05:30",
    });
  });

  it("one end alone is a range too", async () => {
    await render({ occurredFrom: "2026-11-01" });
    expect(stub.asked?.occurredFrom).toBe("2026-11-01T00:00:00.000+05:30");
    expect(stub.asked?.occurredTo).toBeUndefined();
  });

  it("is a filter like any other: Clear filters, and the pager keeps the days, not the instants", async () => {
    stub.page = { events: [EVENT], nextCursor: "c2" };
    const out = await render({ occurredFrom: "2026-11-01", occurredTo: "2026-11-03" });
    expect(out).toContain(">Clear filters<");
    expect(out).toContain('href="/events?occurredFrom=2026-11-01&amp;occurredTo=2026-11-03&amp;cursor=c2"');
  });

  it("a day that is not on the calendar is refused HERE, before any read, and named", async () => {
    // It used to travel as it stood, on the premise that the API refuses it. It does not: the API
    // coerces it (`new Date("2026-02-30")` is 2 March), so the list showed a range nobody asked
    // for under a To field the date input drew blank.
    for (const occurredTo of ["2026-02-30", "2026-2-3", "yesterday"]) {
      stub.asked = null;
      const out = await render({ occurredFrom: "2026-02-01", occurredTo });
      expect(stub.asked, occurredTo).toBeNull();
      expect(out).toContain("That date is not on the calendar");
      expect(out).toContain(`“${occurredTo}” is not a day on the calendar`);
      expect(out).toContain("A date in the filters is not a calendar day.");
      expect(out).not.toContain("The server rejected");
      // Its way out is Clear filters — once on the screen — never a Retry that repeats it.
      expect(out.split(">Clear filters<").length - 1).toBe(1);
      expect(out).not.toContain(">Retry<");
    }
  });

  it("valid days beside an over-long cursor: the CURSOR was refused, not the range", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ occurredFrom: "2026-11-01", cursor: "x".repeat(300) });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain("The server rejected these filters");
  });
});

/** The list itself draws on the data grid and fills a tall window (A4, #2574). */
describe("the list", () => {
  it("is a list page: its rows on the grid, each event's name the row's link to its page", async () => {
    stub.page = {
      events: [
        {
          id: "5eeded00-0005-4a00-8000-000000000005",
          event_name: "payer.suspended",
          event_version: 2,
          actor_type: "admin",
          actor_id: "5eeded00-0009-4a00-8000-000000000009",
          subject_type: "payer",
          subject_id: "5eeded00-0002-4a00-8000-000000000002",
          occurred_at: "2026-11-02T09:00:00.000Z",
          correlation_id: "5eeded00-00c0-4a00-8000-0000000000c0",
          causation_id: null,
        },
      ],
      nextCursor: null,
    };
    const out = await render();
    expect(out).toContain('<div class="page page--list">');
    expect(out).toContain('<div class="grid"');
    expect(out).toMatch(
      /<a class="grid__link" href="\/events\/5eeded00-0005-4a00-8000-000000000005"><span class="grid__link-text" title="payer\.suspended · v2">Customer · suspended<\/span>/,
    );
    // The version follows the link; it is not part of its name.
    expect(out).toContain('</a><span class="table__meta">v2</span>');
  });
});

/**
 * The event-name field's suggestions (A4, #2574): the names the spine recorded lately, read beside
 * the list. A read the page can do without — so it never fails or empties the page.
 */
describe("the event-name suggestions", () => {
  it("hands the filter bar the names the spine recorded lately", async () => {
    await render();
    expect(stub.barProps?.eventNames).toEqual(["profile.confirmed", "worker.created"]);
  });

  it("are still offered beside a refused date — the bar is how the operator corrects it", async () => {
    await render({ occurredTo: "2026-02-30" });
    expect(stub.barProps?.eventNames).toEqual(["profile.confirmed", "worker.created"]);
  });

  it("a failed read leaves the field unsuggested and the list untouched", async () => {
    stub.names = new Error("metrics are down");
    const out = await render();
    expect(stub.barProps?.eventNames).toEqual([]);
    expect(stub.asked).not.toBeNull();
    expect(out).not.toContain("Events are unavailable");
    expect(out).toContain("No events recorded yet");
  });
});
