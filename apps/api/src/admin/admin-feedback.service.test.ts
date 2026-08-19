import { describe, it, expect, vi } from "vitest";
import { AdminFeedbackService } from "./admin-feedback.service";
import type { AdminFeedbackRepository } from "./admin-feedback.repository";
import { decodeEntityCursor, encodeEntityCursor, type EntityCursor } from "./admin-entities.cursor";
import type { AdminFeedbackListItem, AdminFeedbackQueryDto } from "./admin-feedback.dto";

/**
 * The service owns exactly one thing — keyset paging — so that is what this file tests, hard.
 *
 * Paging bugs are the quiet kind: an off-by-one at a page boundary silently drops a row and
 * nothing anywhere reports an error. On THIS screen the dropped row is a worker who took the
 * trouble to tell us something and was never read, which is indistinguishable from the feature
 * working. So the last describe below does not assert on a single page — it walks the entire
 * dataset through the real cursor and asserts the concatenation is that dataset, exactly once.
 */

function repoStub(list: AdminFeedbackRepository["list"]): AdminFeedbackRepository {
  return { list } as unknown as AdminFeedbackRepository;
}

/**
 * A spy over `AdminFeedbackRepository.list`, typed from the repository itself.
 *
 * The explicit type parameter is load-bearing: a bare `vi.fn(async () => [])` infers its call
 * signature as `() => []`, so `mock.calls` is `[][]` and every `calls[0]![1]` below is a
 * COMPILE error — which is how the arguments this service forwards would stop being checked
 * at all if the spy were left untyped.
 */
function listSpy(rows: AdminFeedbackListItem[] = []) {
  return vi.fn<AdminFeedbackRepository["list"]>(async () => rows);
}

/** A query DTO shaped as the Zod pipe hands it over — `limit` already defaulted. */
function query(over: Partial<AdminFeedbackQueryDto> = {}): AdminFeedbackQueryDto {
  return { limit: 50, ...over };
}

/**
 * `n` rows, newest first. Every THIRD row repeats its predecessor's timestamp: ties are the
 * entire reason the keyset carries an `id`, and a fixture of strictly-distinct timestamps
 * cannot fail the assertion that catches the tie-breaker going missing. Real data ties
 * constantly here — a burst of feedback after an app release lands inside one clock tick.
 */
/** A deterministic, canonical-form uuid for fixture `n` — real shape, no randomness. */
function uuidFor(n: number): string {
  const h = String(n).padStart(12, "0");
  return `3f2504e0-4f89-41d3-9a0c-${h}`;
}

function rows(n: number, base = Date.parse("2026-08-19T12:00:00.000Z")): AdminFeedbackListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    // A real uuid, because the service refuses a cursor id that is not one (a non-uuid can
    // only ever fail at BIND against a `uuid` column). Sequenced so the walk below is stable.
    id: uuidFor(n - i),
    worker_id: uuidFor(1000 + (i % 4)),
    category: null,
    message: `message ${i}`,
    app_build: null,
    created_at: new Date(base - Math.floor(i / 3) * 1000),
  }));
}

describe("keyset paging — the page boundary", () => {
  it("over-fetches by exactly one: a page of N asks the repository for N+1", async () => {
    const list = listSpy();
    await new AdminFeedbackService(repoStub(list)).list(query({ limit: 25 }));
    expect(list).toHaveBeenCalledWith({ category: undefined }, null, 26);
  });

  it("returns exactly `limit` items and a cursor when a further row exists", async () => {
    const data = rows(6);
    const svc = new AdminFeedbackService(repoStub(listSpy(data)));
    const page = await svc.list(query({ limit: 5 }));
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    // The cursor points at the LAST RETURNED row (index 4), never at the peeked 6th — pointing
    // at the peeked row would skip it on the next page.
    expect(decodeEntityCursor(page.nextCursor!)).toEqual({
      createdAt: data[4]!.created_at.toISOString(),
      id: data[4]!.id,
    });
  });

  it("a FULL last page reports nextCursor null — no phantom empty page", async () => {
    // The bug this pins: deriving "there is more" from `items.length === limit` shows a Next
    // button whenever the total is an exact multiple of the page size, and the operator lands
    // on an empty screen that reads like data loss.
    const svc = new AdminFeedbackService(repoStub(listSpy(rows(5))));
    const page = await svc.list(query({ limit: 5 }));
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("an empty result is an empty page, not a cursor to nowhere", async () => {
    const svc = new AdminFeedbackService(repoStub(listSpy()));
    const page = await svc.list(query({ limit: 10 }));
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("passes a decoded cursor through to the repository", async () => {
    const list = listSpy();
    const cursor = encodeEntityCursor({ createdAt: "2026-08-19T12:00:00.000Z", id: uuidFor(42) });
    await new AdminFeedbackService(repoStub(list)).list(query({ limit: 10, cursor }));
    expect(list).toHaveBeenCalledWith(
      { category: undefined },
      { createdAt: "2026-08-19T12:00:00.000Z", id: uuidFor(42) },
      11,
    );
  });

  it("a GARBAGE cursor is served as the FIRST page, never as a 500", async () => {
    // A cursor is client-held state: it arrives hand-edited, truncated by a link shortener, or
    // left over from a previous deploy. The third case below is the nasty one — well-formed
    // base64url JSON whose timestamp is not a date, which would otherwise reach the WHERE
    // clause as an Invalid Date and return nothing for reasons invisible in the response.
    const list = listSpy();
    const svc = new AdminFeedbackService(repoStub(list));
    for (const cursor of [
      "not-a-cursor",
      "%%%",
      Buffer.from(JSON.stringify({ c: "yesterday", i: "x" }), "utf8").toString("base64url"),
    ]) {
      await svc.list(query({ limit: 10, cursor }));
    }
    for (const call of list.mock.calls) expect(call[1]).toBeNull();
  });
});

describe("the category filter reaches the repository verbatim", () => {
  it("forwards the requested category", async () => {
    const list = listSpy();
    await new AdminFeedbackService(repoStub(list)).list(query({ limit: 10, category: "problem" }));
    expect(list).toHaveBeenCalledWith({ category: "problem" }, null, 11);
  });

  it("no category means NO filter — undefined, never a default of `other`", async () => {
    // A default here would silently hide every untagged submission, and most of them are
    // untagged: the shipped client omits the key entirely when the worker did not tag.
    const list = listSpy();
    await new AdminFeedbackService(repoStub(list)).list(query({ limit: 10 }));
    expect(list).toHaveBeenCalledWith({ category: undefined }, null, 11);
  });

  it("the filter survives paging — page two is still narrowed", async () => {
    const list = listSpy(rows(4));
    const svc = new AdminFeedbackService(repoStub(list));
    const first = await svc.list(query({ limit: 3, category: "suggestion" }));
    await svc.list(query({ limit: 3, category: "suggestion", cursor: first.nextCursor! }));
    expect(list.mock.calls).toHaveLength(2);
    for (const call of list.mock.calls) expect(call[0]).toEqual({ category: "suggestion" });
  });
});

describe("walking the whole list — no row skipped, no row seen twice", () => {
  /**
   * A repository double applying the SAME semantics as the SQL: total order
   * `(created_at, id)` DESC, keep only rows strictly older than the cursor under that order,
   * take `limit`. Reimplementing the predicate here is deliberate — the property under test is
   * that the cursor the SERVICE emits and the predicate the REPOSITORY applies agree about
   * where the page ended. A double that ignored the cursor would return page one forever and
   * make every assertion below vacuously true.
   */
  function pagingRepo(data: AdminFeedbackListItem[]): AdminFeedbackRepository {
    const ordered = [...data].sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1),
    );
    return repoStub(async (_filter, cursor: EntityCursor | null, limit: number) => {
      if (!cursor) return ordered.slice(0, limit);
      const at = Date.parse(cursor.createdAt);
      const older = ordered.filter(
        (r) => r.created_at.getTime() < at || (r.created_at.getTime() === at && r.id < cursor.id),
      );
      return older.slice(0, limit);
    });
  }

  it("paging a tie-heavy list end to end yields every row exactly once, newest first", async () => {
    const data = rows(20);
    const svc = new AdminFeedbackService(pagingRepo(data));

    const seen: AdminFeedbackListItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.list(query({ limit: 3, cursor }));
      seen.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      // A cursor that fails to advance would loop forever; bound it rather than hang CI.
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(seen.map((r) => r.id)).toEqual(data.map((r) => r.id));
    expect(new Set(seen.map((r) => r.id)).size).toBe(data.length);
  });

  it("rows sharing a timestamp are not collapsed at the boundary (the id tie-breaker)", async () => {
    // Three rows per tick in the fixture, pages of two — so a page boundary lands INSIDE a tie
    // group repeatedly. Without `id` in the cursor the predicate is `created_at < t`, which
    // drops the rest of the group: the list comes up short and nothing errors.
    const data = rows(9);
    const svc = new AdminFeedbackService(pagingRepo(data));

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.list(query({ limit: 2, cursor }));
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(data.map((r) => r.id));
  });

  it("the walk is genuinely multi-page (the fixture is not one page in disguise)", async () => {
    // Guards the two assertions above: if `pagingRepo` ever returned everything at once they
    // would still pass, and would be testing nothing.
    const svc = new AdminFeedbackService(pagingRepo(rows(20)));
    const first = await svc.list(query({ limit: 3 }));
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
  });
});

/**
 * The docstring on `list` promises a malformed cursor is served as the first page rather than a
 * 500. `decodeEntityCursor` validates only the timestamp half, so without a guard here a crafted
 * id reaches a `uuid` column and Postgres rejects it at BIND time (22P02) — a 500 for an operator
 * whose address bar, not the API, is broken.
 */
describe("AdminFeedbackService.list — a crafted cursor id falls back, it does not 500", () => {
  const cursorFor = (c: string, i: string) =>
    Buffer.from(JSON.stringify({ c, i }), "utf8").toString("base64url");

  const VALID_TS = "2026-08-19T12:00:00.000Z";
  const VALID_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  // `listSpy()` and not a bare `vi.fn`: an untyped spy infers `mock.calls` as `[][]`, so every
  // `calls[0]![1]` below is a compile error — the trap this file's own header documents.
  function serviceWithSpy() {
    const list = listSpy();
    const svc = new AdminFeedbackService(repoStub(list));
    return { svc, list };
  }

  it("passes a well-formed uuid cursor straight through", async () => {
    const { svc, list } = serviceWithSpy();
    await svc.list(query({ cursor: cursorFor(VALID_TS, VALID_ID) }));
    expect(list.mock.calls[0]![1]).toEqual({ createdAt: VALID_TS, id: VALID_ID });
  });

  it.each([
    ["a non-uuid id", "x"],
    ["a truncated uuid", "3f2504e0-4f89-41d3-9a0c"],
    ["a uuid with a SQL fragment appended", `${VALID_ID}' or '1'='1`],
    ["an empty id", ""],
  ])("serves the FIRST page for %s", async (_label, id) => {
    const { svc, list } = serviceWithSpy();
    await svc.list(query({ cursor: cursorFor(VALID_TS, id) }));
    // null, not the bad cursor — the repository never sees a value it would bind against uuid.
    expect(list.mock.calls[0]![1]).toBeNull();
  });
});
