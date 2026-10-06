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
  listEvents: async () => {
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

// `useRouter` needs an app-router context this renderer does not provide.
vi.mock("./filter-bar", () => ({ EventFilterBar: () => null }));

const { default: EventsPage } = await import("./page");

beforeEach(() => {
  stub.failure = null;
  stub.page = { events: [], nextCursor: null };
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

  it("past page one: the first page, filters kept", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ subjectType: "worker", cursor: "stale" });
    expect(out).toMatch(
      /href="\/events\?subjectType=worker">(<i [^>]*><\/i>)?Back to the first page<\/a>/,
    );
    expect(out).not.toContain(">Retry<");
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
