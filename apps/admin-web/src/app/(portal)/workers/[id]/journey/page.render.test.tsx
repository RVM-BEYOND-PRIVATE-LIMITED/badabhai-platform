import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The worker-journey screen's link OUT to what that worker told us.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────────
 * Journey and feedback were built without knowing about each other, and each is the missing
 * half of the other: the journey screen is behaviour with no words — it can show that a
 * worker stopped at question four and never say why — and the feedback screen is words with
 * no behaviour. The link between them is the entire point, and a link is exactly the kind of
 * thing that survives a refactor as a plausible-looking href pointing at the wrong query.
 *
 * The reads are stubbed into FAILURE deliberately. Every assertion here is about the page
 * header, which renders identically either way, and a page that still offers a correct link
 * while both of its panels are in their error state is the stronger claim.
 */

const stub = vi.hoisted(() => ({
  capabilities: ["read_entities"] as string[],
  gates: [] as string[],
}));

vi.mock("../../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../../../lib/admin-http", () => ({
  // Never a 404/400 here, so the page renders its error states rather than calling notFound.
  isAdminRequestError: () => false,
}));

vi.mock("../../../../../lib/journey", () => ({
  getWorkerJourney: async () => {
    throw new TypeError("fetch failed");
  },
  listWorkerChatSessions: async () => {
    throw new TypeError("fetch failed");
  },
}));

const { default: WorkerJourneyPage } = await import("./page");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";

beforeEach(() => {
  // Every role holds read_events today, so the realistic session carries it.
  stub.capabilities = ["read_entities", "read_events"];
  stub.gates.length = 0;
});

const render = async (id = WORKER_ID) =>
  renderToStaticMarkup(
    await WorkerJourneyPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    }),
  );

describe("the link to what this worker told us", () => {
  it("narrows the feedback list to THIS worker", async () => {
    // Not a bare `/feedback`. Sending an operator to page one of everyone's messages and
    // asking them to find this worker's is both slower and a worse privacy posture than a
    // lookup on an id already on the screen.
    const out = await render();
    expect(out).toContain(`href="/feedback?workerId=${WORKER_ID}"`);
    expect(out).toContain("What they told us");
  });

  it("gates on read_entities, and does not offer the link without it", async () => {
    // Derived from the session rather than hardcoded: the day `GET /admin/feedback` narrows
    // its capability, this control disappears instead of becoming a link to a redirect.
    stub.capabilities = ["read_events"];
    const out = await render();
    expect(out).not.toContain("/feedback");
    expect(out).not.toContain("What they told us");
    // The rest of the header is untouched — this removes one action, not the page.
    expect(out).toContain(`href="/workers/${WORKER_ID}/timeline"`);
  });

  it("offers the event timeline only with read_events, the timeline route's own gate", async () => {
    stub.capabilities = ["read_entities"];
    const out = await render();
    expect(out).not.toContain(`href="/workers/${WORKER_ID}/timeline"`);
    expect(out).not.toContain("View event timeline");
    // The feedback link is a different capability and stays.
    expect(out).toContain("What they told us");
  });

  it("percent-encodes the id into the query rather than pasting it raw", async () => {
    // A stray `&` in a path segment still resolves to a route that 404s; the same character
    // in a query value truncates the filter, and a truncated workerId is a page showing every
    // worker's messages under a button that said one.
    const out = await render("a&b");
    expect(out).toContain('href="/feedback?workerId=a%26b"');
  });

  it("still gates the page itself on read_entities, before anything renders", async () => {
    await render();
    expect(stub.gates).toEqual(["read_entities"]);
  });
});

describe("the session status chips (owner brief 2026-10-01)", () => {
  const renderWith = async (status?: string) =>
    renderToStaticMarkup(
      await WorkerJourneyPage({
        params: Promise.resolve({ id: WORKER_ID }),
        searchParams: Promise.resolve(status ? { status } : {}),
      }),
    );

  it('mark the active chip aria-current="true", like every other chip set — not "page"', async () => {
    const out = await renderWith("ended");
    // The selected STATE (AW-11), not the primary fill.
    expect(out).toMatch(/aria-current="true" class="btn btn--sm btn--selected"[^>]*>Ended</);
    expect(out).not.toContain("btn--primary");
    expect((out.match(/aria-current="true"/g) ?? []).length).toBe(1);
    expect(out).not.toContain('aria-current="page"');
  });

  it("with no status, All is the current chip", async () => {
    const out = await renderWith();
    expect(out).toMatch(/aria-current="true" class="btn btn--sm btn--selected"[^>]*>All</);
  });
});

/**
 * The session list is a PAGED read, and its failure was prose alone ("Reload this page") — with
 * a stale cursor there was no named way back to page one (sweep AW-15). It now carries the same
 * two recoveries as every other paged list, keeping the status chip.
 */
describe("a failed session list offers the paged list's recoveries", () => {
  const renderWith = async (searchParams: Record<string, string>) =>
    renderToStaticMarkup(
      await WorkerJourneyPage({
        params: Promise.resolve({ id: WORKER_ID }),
        searchParams: Promise.resolve(searchParams),
      }),
    );

  it("Retry repeats the same page, status and cursor kept; the first page keeps the status", async () => {
    const out = await renderWith({ status: "ended", cursor: "c2" });
    expect(out).toContain("The session list could not be loaded");
    expect(out).toContain(
      `href="/workers/${WORKER_ID}/journey?status=ended&amp;cursor=c2"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`,
    );
    expect(out).toContain(
      `href="/workers/${WORKER_ID}/journey?status=ended"><i class="ph-fill ph-arrow-line-left" aria-hidden="true"></i>Back to the first page</a>`,
    );
  });

  it("on page one, Retry alone — and the copy no longer also says reload", async () => {
    const out = await renderWith({});
    expect(out).toContain(
      `href="/workers/${WORKER_ID}/journey"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`,
    );
    expect(out).not.toContain("Back to the first page");
    expect(out).not.toContain("Reload this page to try again");
  });

  it("Retry is the one link to this page — the selected 'All' chip is text (final re-sweep O-2)", async () => {
    const out = await renderWith({});
    expect(out.split(`href="/workers/${WORKER_ID}/journey"`)).toHaveLength(2);
    expect(out).toMatch(/<span aria-current="true" class="btn btn--sm btn--selected">All<\/span>/);
  });
});
