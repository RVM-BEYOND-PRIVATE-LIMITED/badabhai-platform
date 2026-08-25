import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Feedback screen actually RENDERS (#997).
 *
 * ── WHY A RENDER TEST AND NOT A SCHEMA TEST ─────────────────────────────────────────────
 * `lib/feedback.test.ts` covers what is asked for and what is accepted. Neither of those
 * would have noticed the two mistakes that matter on this page, because both live in the
 * markup: an untagged message rendered as "other" (turning "did not say" into "said
 * neither" on a screen ops will count), and a search box appearing on the one surface where
 * worker free text is readable in bulk. `StatusPill` shipped exactly this class of bug once
 * already, and its pure-function test passed the whole time.
 *
 * The page is an async Server Component, so it is awaited into an element tree and rendered
 * with `renderToStaticMarkup` — the same treatment the other render tests here use. Its two
 * server-only seams are replaced: the capability gate, and the data layer.
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
    /** Gate and fetch in the order they happened — the gate must come first. */
    order: [] as string[],
    requests: [] as Array<Record<string, unknown>>,
    page: { items: [] as unknown[], nextCursor: null as string | null },
    failure: null as unknown,
    /** What `/admin/me` reported. Set per test; the REAL `can()` reads it. */
    capabilities: ["read_entities"] as string[],
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../lib/feedback", () => ({
  FEEDBACK_CATEGORIES: ["suggestion", "problem", "other"],
  listFeedback: async (filters: Record<string, unknown>) => {
    stub.order.push("fetch");
    stub.requests.push(filters);
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

const { default: FeedbackPage } = await import("./page");

interface Row {
  id: string;
  worker_id: string;
  category: "suggestion" | "problem" | "other" | null;
  message: string;
  app_build: string | null;
  screen_context: string | null;
  attachment_urls: string[];
  created_at: string;
}

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";

/** Two signed GETs, shaped as the API mints them — token in the query, download hint appended. */
const URL_A =
  "https://project.supabase.co/storage/v1/object/sign/worker-feedback-attachments/" +
  "feedback-attachments/w/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg?token=tokA" +
  "&download=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg";
const URL_B = URL_A.replace("tokA", "tokB").replace(/aaaaaaaa/g, "bbbbbbbb");

/**
 * The message carries a name and a phone number deliberately. They are the worker's OWN, sent
 * to us on purpose, and this screen showing them is the feature — a fixture of lorem ipsum
 * would let the tests below pass while saying nothing about the case that matters.
 */
const TAGGED: Row = {
  id: "ff000000-0001-4a00-8000-000000000001",
  worker_id: WORKER_ID,
  category: "problem",
  message: "App band ho jata hai. Ramesh, 98765 43210.",
  app_build: "9fd0b09",
  screen_context: "/jobs/detail/:id",
  attachment_urls: [],
  created_at: "2026-08-19T09:00:00.000Z",
};

/** An older client: no tag, no build stamp, and no screen — all three absent together. */
const UNTAGGED: Row = {
  ...TAGGED,
  id: "ff000000-0002-4a00-8000-000000000002",
  category: null,
  app_build: null,
  screen_context: null,
  message: "Aur bhasha add karo.",
};

beforeEach(() => {
  stub.order.length = 0;
  stub.requests.length = 0;
  stub.page = { items: [], nextCursor: null };
  stub.failure = null;
  stub.capabilities = ["read_entities"];
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await FeedbackPage({ searchParams: Promise.resolve(searchParams) }));

describe("the gate", () => {
  it("requires read_entities, and requires it BEFORE the read runs", async () => {
    // Order is the assertion. A gate that resolves after the fetch has already returned the
    // rows has audited nothing — the data was fetched either way.
    await render();
    expect(stub.order).toEqual(["gate:read_entities", "fetch"]);
  });
});

describe("the request the page makes", () => {
  it("asks for one short page, unfiltered, by default", async () => {
    await render();
    expect(stub.requests[0]).toEqual({
      category: undefined,
      workerId: undefined,
      cursor: undefined,
      limit: 25,
    });
  });

  it("forwards the category and the cursor from the URL", async () => {
    await render({ category: "problem", cursor: "Y3Vyc29y" });
    expect(stub.requests[0]).toEqual({
      category: "problem",
      workerId: undefined,
      cursor: "Y3Vyc29y",
      limit: 25,
    });
  });

  it("forwards a worker narrowing from the URL", async () => {
    await render({ workerId: WORKER_ID });
    expect(stub.requests[0]).toEqual({
      category: undefined,
      workerId: WORKER_ID,
      cursor: undefined,
      limit: 25,
    });
  });

  it("forwards a workerId that is NOT a uuid rather than silently dropping it", async () => {
    // Same ruling as the category one below. The server's schema is `.uuid()`, so this earns
    // an honest 400; dropping it would show every worker's messages under a URL claiming one
    // worker's, and the operator reading a stranger's complaints would have no way to tell.
    await render({ workerId: "not-a-uuid" });
    expect(stub.requests[0]!.workerId).toBe("not-a-uuid");
  });

  it("forwards an UNKNOWN category rather than silently dropping it", async () => {
    // Dropping it would show the whole list under a URL claiming a filter. Sending it gets an
    // honest 400, which this page renders as an honest refusal.
    await render({ category: "spam" });
    expect(stub.requests[0]!.category).toBe("spam");
  });

  it("takes the first value of a repeated parameter and trims it", async () => {
    await render({ category: ["problem", "other"], cursor: "  Y3Vyc29y  " });
    expect(stub.requests[0]!.category).toBe("problem");
    expect(stub.requests[0]!.cursor).toBe("Y3Vyc29y");
  });

  it("treats a whitespace-only value as absent, not as an empty filter", async () => {
    await render({ category: "   " });
    expect(stub.requests[0]!.category).toBeUndefined();
  });
});

describe("a row", () => {
  beforeEach(() => {
    stub.page = { items: [TAGGED], nextCursor: null };
  });

  it("shows the worker as an opaque id linking to the roster, full value in the title", async () => {
    const out = await render();
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain(`title="${WORKER_ID}"`);
    expect(out).toContain("5eeded00…");
  });

  it("renders the message VERBATIM, in the cell that wraps", async () => {
    // The whole point of the screen. `cell--message` is the one cell exempted from the
    // table's `white-space: nowrap`, so this is also what pins the message to that exemption.
    const out = await render();
    expect(out).toContain(`<td class="cell--message">${TAGGED.message}</td>`);
  });

  it("dates the row relatively, with the absolute instant kept in the title", async () => {
    // Nothing is ever ONLY relative: "2 days ago" is useless in an incident review, so the
    // machine-readable instant stays on the element and the exact UTC stamp in the title.
    const out = await render();
    // A literal regex that CAPTURES, rather than one built from the value: it asserts the
    // datetime the page actually emitted equals the fixture, instead of asserting only that
    // some match exists — and it keeps semgrep's detect-non-literal-regexp satisfied.
    const stamped = out.match(/<time[^>]*datetime="([^"]+)"/i);
    expect(stamped?.[1]).toBe(TAGGED.created_at);
    expect(out).toContain('title="2026-08-19 09:00:00Z"');
  });

  it("shows the build stamp in full — the column exists to compare builds", async () => {
    const out = await render();
    expect(out).toContain("9fd0b09");
  });

  it("tones `problem` as the one tag that reports a fault", async () => {
    const out = await render();
    expect(out).toContain("pill--warn");
    expect(out).toContain(">problem<");
  });

  it("tones `suggestion` neutrally — a worker writing in is not by itself good news", async () => {
    stub.page = { items: [{ ...TAGGED, category: "suggestion" }], nextCursor: null };
    const out = await render();
    expect(out).toContain("pill--muted");
    expect(out).not.toContain("pill--ok");
  });

  it("renders an UNTAGGED message as a dash — never as `other`", async () => {
    // The regression this file exists for. The app omits the tag entirely when the worker
    // skips it; folding that into the third tag would put a lie in any count made here.
    // `>other<` is the pill's text — the "Other" filter chip is capitalised, so this is
    // specific to a row and not to the chip above it.
    stub.page = { items: [UNTAGGED], nextCursor: null };
    const out = await render();
    expect(out).toContain(
      '<span class="table__meta" title="The worker did not tag this.">—</span>',
    );
    expect(out).not.toContain(">other<");
  });

  it("renders a missing build stamp as a dash, and says why on hover", async () => {
    stub.page = { items: [UNTAGGED], nextCursor: null };
    const out = await render();
    expect(out).toContain(
      '<span title="No usable build stamp arrived with this submission.">—</span>',
    );
  });

  it("shows WHICH SCREEN the report is about, verbatim", async () => {
    // The screen name is the whole value of the field: "the job detail page is broken" is a bug
    // report, and "someone said something about something" is not.
    const out = await render();
    expect(out).toContain("/jobs/detail/:id");
    expect(out).toContain("Screen");
    // The class the stylesheet rule below is written against. Asserted HERE because nothing
    // in the toolchain links a className to a rule: the two are checked in separate tests and
    // this is the one that pins which name the markup actually emits.
    expect(out).toContain('class="table__meta cell--screen"');
  });

  it("renders a missing screen as a dash — never a guessed route", async () => {
    // The honesty case, and the one an older app build produces on every row it ever sent.
    // A plausible-looking default here would be indistinguishable from a real one, which is
    // how an operator ends up debugging a screen the worker was never on.
    stub.page = { items: [UNTAGGED], nextCursor: null };
    const out = await render();
    expect(out).toMatch(/<span title="This submission arrived without a screen[^"]*">\s*—\s*<\/span>/);
    expect(out).not.toContain("/jobs/detail/:id");
  });

  it("links the row to that worker's JOURNEY — the half a message cannot show", async () => {
    // Feedback is words with no behaviour. Reading "the apply button does not work" without
    // knowing whether they ever reached a job is guessing, and the alternative is copying an
    // id into another screen by hand.
    const out = await render();
    expect(out).toContain(`href="/workers/${WORKER_ID}/journey"`);
  });

  it("does NOT offer the journey link to an admin who could not open it", async () => {
    // The link is derived from the session's capabilities, never hardcoded — so the day the
    // journey routes narrow, the control moves with them instead of becoming a redirect.
    stub.capabilities = [];
    const out = await render();
    expect(out).not.toContain("/journey");
    // …and the row is otherwise intact: the worker link and the message are still there.
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain(TAGGED.message);
  });

  it("claims newest-first in the caption, and counts the page honestly", async () => {
    stub.page = { items: [TAGGED, UNTAGGED], nextCursor: null };
    const out = await render();
    expect(out).toContain("Worker feedback, newest first");
    expect(out).toContain("2 messages on this page.");
  });

  it("uses the singular for one row", async () => {
    const out = await render();
    expect(out).toContain("1 message on this page.");
  });
});

describe("what this screen refuses to offer", () => {
  it("has NO text box — worker free text is not searchable from here", async () => {
    // The load-bearing refusal. A search field over `message` would be a way to find every
    // worker who typed a phone number, which is a PII discovery tool however it is labelled.
    // Category is a set of links precisely so this surface has no free-text input at all.
    stub.page = { items: [TAGGED], nextCursor: null };
    const out = await render();
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<form");
    expect(out).not.toContain('role="search"');
  });

  it("offers no identity affordance — the only worker link is the opaque roster row", async () => {
    stub.page = { items: [TAGGED], nextCursor: null };
    const out = await render();
    expect(out).not.toContain("reveal");
    expect(out).not.toMatch(/href="[^"]*\/workers\/[^"]*\/(contact|reveal)/);
  });
});

describe("the category chips", () => {
  /**
   * One chip's opening tag, whatever order React chose to emit its attributes in.
   *
   * A literal regex for the anchors, then a plain substring match for the one we want — not
   * a `new RegExp` built from `category`, which is the non-literal-regexp pattern semgrep
   * blocks (and which would need `category` escaped to be correct anyway).
   */
  const chip = (html: string, category: string) =>
    (html.match(/<a[^>]*>/g) ?? []).find((tag) => tag.includes(`/feedback?category=${category}`)) ??
    "";

  it("renders one link per tag, none of them selected on the unfiltered page", async () => {
    const out = await render();
    for (const label of ["Suggestions", "Problems", "Other"]) expect(out).toContain(label);
    expect(out).not.toContain("btn--primary");
    expect(out).not.toContain('aria-current="true"');
  });

  it("marks the active chip for assistive tech, not by colour alone", async () => {
    const out = await render({ category: "problem" });
    expect(chip(out, "problem")).toContain("btn--primary");
    expect(chip(out, "problem")).toContain('aria-current="true"');
    expect(chip(out, "other")).toContain("btn--ghost");
    expect(chip(out, "other")).not.toContain("aria-current");
  });

  it("a chip never carries the current cursor — changing the filter restarts at page one", async () => {
    // Page three's cursor applied to a different query returns an arbitrary slice of it,
    // which looks like data rather than like an error.
    stub.page = { items: [TAGGED], nextCursor: "bmV4dA" };
    const out = await render({ category: "problem", cursor: "Y3Vyc29y" });
    for (const category of ["suggestion", "problem", "other"]) {
      expect(chip(out, category), `the ${category} chip must not carry a cursor`).not.toContain(
        "cursor",
      );
    }
  });
});

/**
 * ⚠ EVERY ASSERTION IN HERE NARROWS ON A WORKER THE ROWS DO NOT BELONG TO, AND THAT IS THE
 * POINT — the banner is the ONLY thing on the page that can then name `WORKER_ID`.
 *
 * These tests used to render `[TAGGED]`, whose `worker_id` IS the id being filtered on, so the
 * table's own Worker cell and its own Journey link emitted both strings under assertion and the
 * banner was proved by nothing. Measured on the original suite: deleting the banner's entire
 * journey link left 52/52 green, and replacing the banner's `{shortId(workerId)}` with a
 * literal `"ZZZZZZZZ"` left 52/52 green.
 *
 * Rendering an EMPTY page is not the fix either — it swaps one third source for another, the
 * empty-filtered state's own "Open their journey" button. Rows belonging to someone else keep
 * the table on screen while leaving the filtered id unsourced anywhere but the banner. It is
 * also a real state: a stale cursor, or a deletion between two requests.
 */
describe("the worker narrowing", () => {
  /** A row that is NOT the worker being filtered on. */
  const OTHERS_ROW: Row = {
    ...TAGGED,
    id: "ff000000-0003-4a00-8000-000000000003",
    worker_id: "abcde000-0002-4a00-8000-000000000002",
  };

  beforeEach(() => {
    stub.page = { items: [OTHERS_ROW], nextCursor: null };
  });

  it("says WHICH worker is being shown, and offers the way back out", async () => {
    // A narrowing an operator cannot see is one URL away from being read as the whole list.
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain("Showing only what worker");
    expect(out).toContain("5eeded00…");
    expect(out).toContain("Show every worker");
    // …and it names the FILTERED worker, not whoever happens to be in the first row.
    expect(out).not.toContain("Showing only what worker <span class=\"mono\">abcde000…");
  });

  it("links from the narrowing to that worker's journey", async () => {
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain(`href="/workers/${WORKER_ID}/journey"`);
  });

  it("says nothing about a worker when none is selected", async () => {
    const out = await render();
    expect(out).not.toContain("Showing only what worker");
  });

  it("does NOT claim to be showing a worker's messages when nothing was fetched", async () => {
    // "Showing only what worker X sent" over a refusal or an outage is a sentence about a
    // list that does not exist — and an operator would read the empty screen under it as an
    // answer about that worker rather than as a failure.
    stub.failure = new stub.RequestError(400);
    const refused = await render({ workerId: "not-a-uuid" });
    expect(refused).toContain("The server rejected this request");
    expect(refused).not.toContain("Showing only what worker");

    stub.failure = new TypeError("fetch failed");
    const down = await render({ workerId: WORKER_ID });
    expect(down).toContain("Feedback is unavailable");
    expect(down).not.toContain("Showing only what worker");
  });

  it("percent-encodes the id it puts back into a path", async () => {
    // A worker filter reaches this page straight from the address bar, so it is not
    // guaranteed to be a uuid — an unescaped `#` or `?` in a link would silently point at a
    // different route than the one the text claims.
    const out = await render({ workerId: "a#b" });
    expect(out).toContain('href="/workers/a%23b"');
  });

  it("a category chip KEEPS the worker narrowing", async () => {
    // Picking a tag while looking at one worker means "this worker's problems". Widening to
    // everyone's on a click would hand an operator messages they did not ask to read.
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain(`href="/feedback?category=problem&amp;workerId=${WORKER_ID}"`);
  });

  it("pages WITHOUT losing the worker narrowing", async () => {
    // The failure this catches is a second page that quietly shows everyone, under a heading
    // that still claims one worker.
    stub.page = { items: [TAGGED], nextCursor: "bmV4dA" };
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain(`href="/feedback?workerId=${WORKER_ID}&amp;cursor=bmV4dA"`);
  });

  it("keeps the narrowing on the way back from a dead page", async () => {
    stub.page = { items: [], nextCursor: null };
    const out = await render({ workerId: WORKER_ID, cursor: "Y3Vyc29y" });
    expect(out).toContain("Nothing further on this page");
    expect(out).toContain(`href="/feedback?workerId=${WORKER_ID}"`);
  });

  it("clears BOTH filters at once when both are set, and says so", async () => {
    const out = await render({ workerId: WORKER_ID, category: "problem" });
    expect(out).toContain("Clear filters");
    expect(out).toContain('href="/feedback"');
  });
});

describe("the empty states, which are four different claims", () => {
  it("unfiltered and empty: nothing has been submitted, and the spine is where to check", async () => {
    const out = await render();
    expect(out).toContain("No feedback submitted yet");
    expect(out).toContain("/events?eventName=feedback.submitted");
    // Nothing to clear, so nothing is offered — the link used to point at the page you were
    // already on, which is the emptiest recovery action there is.
    expect(out).not.toContain("Clear filter");
  });

  it("filtered and empty: the tag is empty, and clearing it is the way out", async () => {
    const out = await render({ category: "other" });
    expect(out).toContain("No feedback carries this tag");
    expect(out).toContain("Clear filter");
    expect(out).not.toContain("No feedback submitted yet");
  });

  /**
   * A worker-narrowed empty page is a THIRD claim, not the tag one with a different filter.
   * "No feedback carries this tag" under a worker narrowing answers a question nobody asked
   * and hides the one they did — and silence from one worker is the ordinary case, not a
   * verdict on their experience, which is the reading the copy has to head off.
   */
  it("worker-narrowed and empty: says THIS worker sent nothing, and offers their journey", async () => {
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain("This worker has sent no feedback");
    expect(out).toContain(`href="/workers/${WORKER_ID}/journey"`);
    expect(out).not.toContain("No feedback carries this tag");
    expect(out).not.toContain("No feedback submitted yet");
  });

  it("worker-narrowed AND tagged, and empty: claims neither of the other two", async () => {
    // "This worker has sent no feedback" would be flatly false the moment they had written
    // in untagged, so the way out offered first is dropping the tag rather than the worker.
    const out = await render({ workerId: WORKER_ID, category: "problem" });
    expect(out).toContain("Nothing from this worker carries this tag");
    expect(out).toContain("Drop the tag");
    expect(out).toContain(`href="/feedback?workerId=${WORKER_ID}"`);
    expect(out).not.toContain("This worker has sent no feedback");
  });

  /**
   * An empty page PAST the first is not evidence the table is empty. Rows behind a cursor go
   * away routinely — `worker_feedback` cascades from `workers`, so an account-deletion sweep
   * between two requests empties the page the operator is on while the list ahead of it is
   * still full. The old copy sent them to debug a submit path that was working.
   */
  it("deep-paged and empty: says THIS page is empty, not that nothing was ever sent", async () => {
    const out = await render({
      cursor:
        "eyJjIjoiMjAyNi0wOC0xOVQxMjowMDowMC4wMDBaIiwiaSI6IjNmMjUwNGUwLTRmODktNDFkMy05YTBjLTAzMDVlODJjMzMwMSJ9",
    });
    expect(out).toContain("Nothing further on this page");
    expect(out).not.toContain("No feedback submitted yet");
    // …and it offers a way back, which the old branch did not: Pager renders nothing when
    // nextCursor is null, so an operator on a dead page had no link at all.
    expect(out).toContain("Back to the newest");
  });

  it("deep-paged, filtered and empty: the way back KEEPS the filter", async () => {
    const out = await render({
      category: "problem",
      cursor:
        "eyJjIjoiMjAyNi0wOC0xOVQxMjowMDowMC4wMDBaIiwiaSI6IjNmMjUwNGUwLTRmODktNDFkMy05YTBjLTAzMDVlODJjMzMwMSJ9",
    });
    expect(out).toContain("Nothing further on this page");
    expect(out).toContain("/feedback?category=problem");
  });
});

describe("the two failures, which are also different claims", () => {
  it("a 400 is the operator's URL, not our outage — and offers the undo", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ category: "spam" });
    expect(out).toContain("The server rejected this request");
    expect(out).toContain("Clear filter");
    expect(out).not.toContain("Feedback is unavailable");
  });

  it("a 400 on a cursor offers a first page, because there is no filter to clear", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ cursor: "x".repeat(300) });
    expect(out).toContain("Back to the first page");
    expect(out).not.toContain("Clear filter");
  });

  it("a 400 with nothing in the URL offers NO action — there is nothing to undo", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render();
    expect(out).toContain("The server rejected this request");
    expect(out).not.toContain("state__actions");
  });

  it("anything else is our fault and says so, retrying the SAME query", async () => {
    // Telling an operator to check their filters while the API is down sends them to fix
    // something that is not broken; a "Retry" that drops the filter and the cursor returns
    // them to page one while claiming to have retried.
    stub.failure = new TypeError("fetch failed");
    const out = await render({ category: "problem", cursor: "Y3Vyc29y" });
    expect(out).toContain("Feedback is unavailable");
    expect(out).toContain("Nothing was fetched.");
    expect(out).toContain('href="/feedback?category=problem&amp;cursor=Y3Vyc29y"');
    expect(out).not.toContain("The server rejected this request");
  });
});

describe("paging", () => {
  it("carries the filter, and only the newest cursor, into the next page", async () => {
    stub.page = { items: [TAGGED], nextCursor: "bmV4dA" };
    const out = await render({ category: "problem", cursor: "Y3Vyc29y" });
    expect(out).toContain('href="/feedback?category=problem&amp;cursor=bmV4dA"');
    expect(out).not.toContain("cursor=Y3Vyc29y");
  });

  it("renders no pager on the last page", async () => {
    stub.page = { items: [TAGGED], nextCursor: null };
    const out = await render();
    expect(out).not.toContain("Next page");
  });
});

describe("the message cell is really exempt from the table's nowrap", () => {
  /**
   * `globals.css` carries its own scar for exactly this: a className rendered with no rule
   * behind it "passed every gate while rendering wrong", because nothing in the toolchain
   * links a class name to a stylesheet. Here the consequence would be a 4000-character
   * paragraph laid out on ONE line, i.e. a worker's complaint readable only by dragging the
   * horizontal scrollbar past four other columns.
   */
  const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const css = readFileSync(join(dir, "../../globals.css"), "utf8");
  const ruleFor = (selector: string) => {
    const start = css.indexOf(selector);
    expect(start, `no rule declares \`${selector}\``).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("undoes `white-space: nowrap` for the one cell that holds a sentence", () => {
    const rule = ruleFor(".table--prose .cell--message");
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("bounds the measure with the shared reading TOKEN, never a literal", () => {
    // The stylesheet's own rule: "If a value is missing from tokens.css, the fix is a token
    // — not a literal here." A raw px measure would also fail the repo's DS-adherence lint.
    expect(ruleFor(".table--prose .cell--message")).toMatch(
      /max-inline-size:\s*var\(--reading-max\)/,
    );
  });

  it("tops the short cells beside it, so a tall row still reads as one row", () => {
    expect(ruleFor(".table--prose td")).toMatch(/vertical-align:\s*top/);
  });

  /**
   * Same scar, second column. The server accepts a route pattern up to 128 characters, and
   * under the table's `nowrap` one of those would push the message column off the right edge
   * — reinstating, through a different cell, exactly the horizontal drag the rule above was
   * carved out to remove. A class name with no rule behind it renders wrong while passing
   * every other gate, so the rule is asserted rather than assumed.
   */
  it("wraps and bounds the screen cell instead of letting a long route widen the table", () => {
    // The selector is matched WITH its brace. Without it the lookup is a prefix search, and
    // renaming the rule to `.cell--screen-unused` — the exact shape of the bug this file
    // exists to catch — still matched, so the assertion could not fail. Caught by mutating
    // the rule name and watching this test stay green.
    const rule = ruleFor(".table--prose .cell--screen {");
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/max-inline-size:\s*\d+ch/);
  });
});

/**
 * ── THE IMAGES COLUMN (#1191) ────────────────────────────────────────────────────────────
 *
 * Rendered, not inferred. Three things can only be checked in the markup: that a click opens
 * the image WITHOUT handing this page's `?workerId=` filter to the storage origin in a
 * `Referer`, that the thumbnail is a plain `<img>` rather than the Next optimizer (which
 * caches by url and would outlive the signature), and that "no images" reads the same dash as
 * every other absent value on this row rather than as a broken cell.
 */
describe("the images column (#1191)", () => {
  const WITH_IMAGES: Row = { ...TAGGED, attachment_urls: [URL_A, URL_B] };

  it("renders one linked thumbnail per url, both pointing at the SIGNED url", async () => {
    stub.page = { items: [WITH_IMAGES], nextCursor: null };
    const html = await render();

    expect(html).toContain(`href="${escapeHtml(URL_A)}"`);
    expect(html).toContain(`href="${escapeHtml(URL_B)}"`);
    expect(html).toContain(`src="${escapeHtml(URL_A)}"`);
    expect(html).toContain(`src="${escapeHtml(URL_B)}"`);
  });

  it("opens in a new tab with rel=noreferrer — the filter must not ride a Referer", async () => {
    // `noreferrer` implies `noopener` (the opened tab cannot navigate this console) AND
    // suppresses the header, which on THIS page would otherwise carry `?workerId=<uuid>` to
    // the storage origin.
    stub.page = { items: [WITH_IMAGES], nextCursor: null };
    const html = await render({ workerId: WORKER_ID });

    const anchors = html.match(/<a class="thumb"[^>]*>/g) ?? [];
    expect(anchors).toHaveLength(2);
    for (const a of anchors) {
      expect(a).toContain('rel="noreferrer"');
      expect(a).toContain('target="_blank"');
    }
  });

  it("uses a PLAIN img — never the Next optimizer, which would outlive the signature", async () => {
    // `next/image` rewrites the src to `/_next/image?url=…` and caches by that url, so a
    // worker's private photograph would keep being served after the signed url expired.
    stub.page = { items: [WITH_IMAGES], nextCursor: null };
    const html = await render();
    expect(html).not.toContain("/_next/image");
  });

  it("gives every thumbnail a real alt, so the column is readable without images", async () => {
    stub.page = { items: [WITH_IMAGES], nextCursor: null };
    const html = await render();
    expect(html).toContain('alt="Attachment 1 of 2"');
    expect(html).toContain('alt="Attachment 2 of 2"');
  });

  it("renders a DASH when there are none — the same absent-value mark as the rest of the row", async () => {
    // Empty has four causes this page cannot tell apart (nothing attached, a row older than
    // the feature, an unprovisioned bucket, a signing failure). All four mean "no images", so
    // none of them is claimed.
    stub.page = { items: [TAGGED], nextCursor: null };
    const html = await render();
    expect(html).not.toContain('class="thumb"');
    expect(html).toContain("No images are shown for this submission.");
  });

  it("adds exactly one column to the header, between Screen and Message", async () => {
    stub.page = { items: [TAGGED], nextCursor: null };
    const html = await render();
    const headers = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual(["When", "Worker", "Category", "Build", "Screen", "Images", "Message"]);
  });

  it("still shows the MESSAGE for a row whose images are missing — the words are the feature", async () => {
    // The server fails OPEN on signing precisely so this holds: a Storage blip costs the
    // thumbnails, never the complaint.
    stub.page = { items: [{ ...TAGGED, attachment_urls: [] }], nextCursor: null };
    const html = await render();
    expect(html).toContain("App band ho jata hai.");
  });
});

/** Minimal entity-escaping, matching what `renderToStaticMarkup` does to an attribute value. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
