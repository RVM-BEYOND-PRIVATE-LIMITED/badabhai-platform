import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ZodType } from "zod";

/**
 * The worker-feedback data layer (#997).
 *
 * Three properties are load-bearing here, and every one of them is easy to regress without
 * anything visibly breaking:
 *
 *  1. WHAT IS ASKED FOR. The route offers exactly one filter — `category`. This module must
 *     never grow a second one that searches the message body: `?q=9876` over worker free text
 *     is a PII discovery tool wearing a convenience feature's costume, and it would arrive
 *     looking like a small usability win.
 *  2. WHAT IS ACCEPTED. The three category tokens are frozen in a SHIPPED app. A fourth
 *     arriving means the server changed under the portal, which is worth failing over rather
 *     than rendering as an unstyled word.
 *  3. WHAT CANNOT ARRIVE. The projection is the whole contract. A name or a phone number is
 *     not in it, and the parse must drop one rather than let a server regression put worker
 *     identity onto a bulk-readable list.
 *
 * `adminFetch` is replaced with a double that records the path and then parses the body
 * through the SCHEMA IT WAS HANDED — the real transport's contract. Reproducing that is the
 * point: it makes "which schema did this call actually validate against" a checked property
 * rather than an assumption about a line of code.
 */

const transport = vi.hoisted(() => ({
  calls: [] as string[],
  /** What the server answers next. Set per test; parsed THROUGH the schema, never around it. */
  body: { items: [], nextCursor: null } as unknown,
}));

vi.mock("./admin-http", () => ({
  adminFetch: async (path: string, opts: { schema: ZodType<unknown> }) => {
    transport.calls.push(path);
    return opts.schema.parse(transport.body);
  },
}));

const { FEEDBACK_CATEGORIES, feedbackItemSchema, feedbackPageSchema, listFeedback } =
  await import("./feedback");

/**
 * One row, field-for-field as `AdminFeedbackListItem` projects it
 * (apps/api/src/admin/admin-feedback.dto.ts) — `created_at` as the ISO string a `Date` becomes
 * on the wire, `category`/`app_build` as the nullable columns they are.
 *
 * The message deliberately contains a name and a phone number. That is not an oversight: it is
 * the ONE field on this surface allowed to carry them, because the worker chose to send them,
 * and a fixture full of "lorem ipsum" would not say so.
 */
const ROW = {
  id: "ff000000-0001-4a00-8000-000000000001",
  worker_id: "5eeded00-0001-4a00-8000-000000000001",
  category: "problem",
  message: "App band ho jata hai. Ramesh, 98765 43210.",
  app_build: "9fd0b09",
  created_at: "2026-08-19T09:00:00.000Z",
};

beforeEach(() => {
  transport.calls.length = 0;
  transport.body = { items: [], nextCursor: null };
});

const lastPath = () => transport.calls[transport.calls.length - 1]!;

describe("listFeedback — the request it actually makes", () => {
  it("asks for the bare route when nothing is filtered", async () => {
    await listFeedback();
    expect(lastPath()).toBe("/admin/feedback");
  });

  it("carries the category, the cursor and the page size", async () => {
    await listFeedback({ category: "problem", cursor: "Y3Vyc29y", limit: 25 });
    expect(lastPath()).toBe("/admin/feedback?category=problem&cursor=Y3Vyc29y&limit=25");
  });

  it("OMITS an empty category rather than sending `?category=`", async () => {
    // The server's schema is a `.strict()` enum, so a blank value is a 400 — the whole page
    // would fail because a control was cleared rather than set.
    await listFeedback({ category: "", cursor: undefined });
    expect(lastPath()).toBe("/admin/feedback");
  });

  it("FORWARDS an unknown category instead of quietly dropping it", async () => {
    // A hand-edited `?category=spam` must reach the server and be refused. Dropping it here
    // would render the WHOLE list under a URL claiming a filter — a wrong answer wearing a
    // right one's clothes, which is exactly what the server's strict schema exists to stop.
    await listFeedback({ category: "spam" });
    expect(lastPath()).toBe("/admin/feedback?category=spam");
  });

  it("offers NO search over the message body — the query surface is exactly three keys", async () => {
    // The load-bearing one. `GET /admin/feedback` has no free-text search and this module must
    // never grow a client-side equivalent; if a fourth parameter ever appears in a request,
    // someone has to come here and say why it is not a way to grep worker free text.
    await listFeedback({ category: "other", cursor: "c", limit: 25 });
    const params = new URL(`https://portal.invalid${lastPath()}`).searchParams;
    expect([...params.keys()].sort()).toEqual(["category", "cursor", "limit"]);
  });

  it("returns the parsed page, not the raw body", async () => {
    transport.body = { items: [ROW], nextCursor: "bmV4dA" };
    const page = await listFeedback();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.category).toBe("problem");
    expect(page.nextCursor).toBe("bmV4dA");
  });

  it("a body the schema rejects becomes a thrown error, never a half-rendered page", async () => {
    transport.body = { items: [{ ...ROW, message: undefined }], nextCursor: null };
    await expect(listFeedback()).rejects.toThrow();
  });
});

describe("the category vocabulary — mirrored from the server, and closed", () => {
  it("is exactly the three tokens the shipped app can send", () => {
    // Pins the mirror of WORKER_FEEDBACK_CATEGORIES (@badabhai/types), which is itself pinned
    // to the Dart enum already in workers' hands. A fourth token here without one there would
    // render a chip that can never match a row.
    expect([...FEEDBACK_CATEGORIES]).toEqual(["suggestion", "problem", "other"]);
  });

  it("accepts each of them on a row", () => {
    for (const category of FEEDBACK_CATEGORIES) {
      expect(feedbackItemSchema.parse({ ...ROW, category }).category).toBe(category);
    }
  });

  it("accepts null — untagged is a real answer, and it is not `other`", () => {
    expect(feedbackItemSchema.parse({ ...ROW, category: null }).category).toBeNull();
  });

  it("rejects anything else, rather than rendering it raw", () => {
    for (const bad of ["spam", "Suggestion", "", "problem ", "PROBLEM"]) {
      expect(
        feedbackItemSchema.safeParse({ ...ROW, category: bad }).success,
        `category "${bad}" must not parse`,
      ).toBe(false);
    }
  });
});

describe("the row schema — the sanctioned exception, and its edges", () => {
  it("parses the server's projection", () => {
    const row = feedbackItemSchema.parse(ROW);
    expect(row.worker_id).toBe(ROW.worker_id);
    expect(row.app_build).toBe("9fd0b09");
  });

  it("carries the message VERBATIM — this is the field the screen exists for", () => {
    // The portal does not redact it. The server decided admins may read it; masking a payload
    // already on the wire would be theatre, and a half-shown complaint is not readable.
    expect(feedbackItemSchema.parse(ROW).message).toBe(ROW.message);
  });

  it("accepts a null app_build — an absent or malformed build stamp is not a bad row", () => {
    expect(feedbackItemSchema.parse({ ...ROW, app_build: null }).app_build).toBeNull();
  });

  it("requires the message — an absent one must fail, not render as `undefined`", () => {
    const { message: _drop, ...rest } = ROW;
    expect(feedbackItemSchema.safeParse(rest).success).toBe(false);
  });

  it("requires created_at as a string — the wire form of the server's timestamp", () => {
    expect(feedbackItemSchema.safeParse({ ...ROW, created_at: 1_755_594_000_000 }).success).toBe(
      false,
    );
  });
});

describe("the page envelope", () => {
  it("is `{ items, nextCursor }` — the entity shape, not the events one", () => {
    // `lib/events.ts` answers `{ events, nextCursor }`. Reading this route with that shape
    // would parse to nothing and show "unavailable" on a perfectly healthy response.
    expect(feedbackPageSchema.safeParse({ events: [ROW], nextCursor: null }).success).toBe(false);
    expect(feedbackPageSchema.parse({ items: [ROW], nextCursor: null }).items).toHaveLength(1);
  });

  it("REQUIRES nextCursor — an absent cursor is not the same claim as a null one", () => {
    // Null means "this was the last page". Absent means the server did not say, and treating
    // that as the end silently hides every page after the first.
    expect(feedbackPageSchema.safeParse({ items: [] }).success).toBe(false);
    expect(feedbackPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });
});

describe("privacy — the projection cannot grow an identity field", () => {
  it("DROPS a name or a phone number the server should never have sent", () => {
    // The one direction this schema must fail in. If the admin API ever regressed into
    // joining `workers`, the portal must not start rendering the result: an unparsed extra
    // field is discarded here, so a worker's identity cannot reach a bulk-readable list
    // through a data-layer that was never asked to change.
    const parsed = feedbackItemSchema.parse({
      ...ROW,
      worker_name: "Ramesh Kumar",
      worker_phone: "+919876543210",
    });
    expect(parsed).not.toHaveProperty("worker_name");
    expect(parsed).not.toHaveProperty("worker_phone");
    expect(Object.keys(parsed).sort()).toEqual([
      "app_build",
      "category",
      "created_at",
      "id",
      "message",
      "worker_id",
    ]);
  });
});
