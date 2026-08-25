import { describe, it, expect, vi } from "vitest";
import { AdminFeedbackService } from "./admin-feedback.service";
import type { AdminFeedbackRepository } from "./admin-feedback.repository";
import { decodeEntityCursor, encodeEntityCursor, type EntityCursor } from "./admin-entities.cursor";
import type {
  AdminFeedbackListItem,
  AdminFeedbackQueryDto,
  AdminFeedbackRow,
} from "./admin-feedback.dto";
import type { EventsService } from "../events/events.service";
import type { StorageService } from "../storage/storage.service";
import type { RequestContext } from "../common/request-context";

/**
 * The service owns exactly one thing — keyset paging — so that is what this file tests, hard.
 *
 * Paging bugs are the quiet kind: an off-by-one at a page boundary silently drops a row and
 * nothing anywhere reports an error. On THIS screen the dropped row is a worker who took the
 * trouble to tell us something and was never read, which is indistinguishable from the feature
 * working. So the last describe below does not assert on a single page — it walks the entire
 * dataset through the real cursor and asserts the concatenation is that dataset, exactly once.
 */

const ADMIN = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CTX = { correlationId: "corr-1", requestId: "req-1" } as unknown as RequestContext;

function repoStub(list: AdminFeedbackRepository["list"]): AdminFeedbackRepository {
  return { list } as unknown as AdminFeedbackRepository;
}

/**
 * One captured `EventsService.emit` call. The parameter is DECLARED even though the double
 * ignores it: without it `emit.mock.calls[0]` types as the empty tuple and every assertion on
 * what reached the spine becomes a compile error.
 */
function eventsStub(opts: { throws?: boolean } = {}) {
  const emit = vi.fn(async (_params: Record<string, unknown>) => {
    if (opts.throws) throw new Error("simulated emit failure");
    return { event_id: "e-1" };
  });
  return { emit, events: { emit } as unknown as EventsService };
}

/**
 * The service under test, wired to a repository double and an emit spy.
 *
 * Every existing test in this file calls `svc.list(...)` through this, so the audit emission is
 * exercised by all of them — a change that dropped the emit would fail the dedicated assertions
 * below AND leave every paging test running against a service that no longer audits.
 */
function svcWith(
  list: AdminFeedbackRepository["list"],
  opts: { emitThrows?: boolean; bucket?: string; signThrowsFor?: (path: string) => boolean } = {},
) {
  const { emit, events } = eventsStub({ throws: opts.emitThrows });
  const { storage, sign } = storageStub(opts);
  return { svc: new AdminFeedbackService(repoStub(list), events, storage, cfg(opts.bucket)), emit, sign };
}

/** The attachments bucket, as an armed deployment has it. Empty means DORMANT. */
const BUCKET = "worker-feedback-attachments";
/** The TTL the signed GETs are minted with — the resume download's, reused deliberately. */
const TTL = 900;

/** The two config values this service reads, and nothing else. */
const cfg = (bucket?: string) =>
  ({
    WORKER_FEEDBACK_ATTACHMENTS_BUCKET: bucket ?? BUCKET,
    RESUME_SIGNED_URL_TTL_SECONDS: TTL,
  }) as never;

/**
 * A `StorageService` double that mints a recognisable url per key — and can be told to fail for
 * a chosen path, which is how the FAIL-OPEN posture is exercised. Every call is recorded, so the
 * tests can assert that the over-fetched row is never signed and that the download hint is set.
 */
function storageStub(opts: { signThrowsFor?: (path: string) => boolean } = {}) {
  const sign = vi.fn(
    async (objectKey: string, ttlSeconds: number, bucket?: string, downloadAs?: string) => {
      if (opts.signThrowsFor?.(objectKey)) throw new Error("simulated storage failure");
      return `https://storage.test/${bucket}/${objectKey}?token=t&ttl=${ttlSeconds}` +
        (downloadAs ? `&download=${downloadAs}` : "");
    },
  );
  return { sign, storage: { createSignedUrl: sign } as unknown as StorageService };
}

/** A key this server would have minted, for the worker on fixture row `n`. */
function pathFor(n: number): string {
  return `feedback-attachments/${uuidFor(1000 + n)}/aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, "0")}.jpg`;
}

/**
 * A spy over `AdminFeedbackRepository.list`, typed from the repository itself.
 *
 * The explicit type parameter is load-bearing: a bare `vi.fn(async () => [])` infers its call
 * signature as `() => []`, so `mock.calls` is `[][]` and every `calls[0]![1]` below is a
 * COMPILE error — which is how the arguments this service forwards would stop being checked
 * at all if the spy were left untyped.
 */
function listSpy(rows: AdminFeedbackRow[] = []) {
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

function rows(n: number, base = Date.parse("2026-08-19T12:00:00.000Z")): AdminFeedbackRow[] {
  return Array.from({ length: n }, (_, i) => ({
    // A real uuid, because the service refuses a cursor id that is not one (a non-uuid can
    // only ever fail at BIND against a `uuid` column). Sequenced so the walk below is stable.
    id: uuidFor(n - i),
    worker_id: uuidFor(1000 + (i % 4)),
    category: null,
    message: `message ${i}`,
    app_build: null,
    screen_context: null,
    // The REPOSITORY's shape: stored keys, not urls. The service is what turns one into the
    // other, and typing the fixture this way is what makes a projection that forgot to a
    // compile error rather than a review catch.
    attachment_paths: [],
    created_at: new Date(base - Math.floor(i / 3) * 1000),
  }));
}

describe("keyset paging — the page boundary", () => {
  it("over-fetches by exactly one: a page of N asks the repository for N+1", async () => {
    const list = listSpy();
    await svcWith(list).svc.list(ADMIN, query({ limit: 25 }), CTX);
    expect(list).toHaveBeenCalledWith({ category: undefined, workerId: undefined }, null, 26);
  });

  it("returns exactly `limit` items and a cursor when a further row exists", async () => {
    const data = rows(6);
    const svc = svcWith(listSpy(data)).svc;
    const page = await svc.list(ADMIN, query({ limit: 5 }), CTX);
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
    const svc = svcWith(listSpy(rows(5))).svc;
    const page = await svc.list(ADMIN, query({ limit: 5 }), CTX);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("an empty result is an empty page, not a cursor to nowhere", async () => {
    const svc = svcWith(listSpy()).svc;
    const page = await svc.list(ADMIN, query({ limit: 10 }), CTX);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("passes a decoded cursor through to the repository", async () => {
    const list = listSpy();
    const cursor = encodeEntityCursor({ createdAt: "2026-08-19T12:00:00.000Z", id: uuidFor(42) });
    await svcWith(list).svc.list(ADMIN, query({ limit: 10, cursor }), CTX);
    expect(list).toHaveBeenCalledWith(
      { category: undefined, workerId: undefined },
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
    const svc = svcWith(list).svc;
    for (const cursor of [
      "not-a-cursor",
      "%%%",
      Buffer.from(JSON.stringify({ c: "yesterday", i: "x" }), "utf8").toString("base64url"),
    ]) {
      await svc.list(ADMIN, query({ limit: 10, cursor }), CTX);
    }
    for (const call of list.mock.calls) expect(call[1]).toBeNull();
  });
});

describe("the category filter reaches the repository verbatim", () => {
  it("forwards the requested category", async () => {
    const list = listSpy();
    await svcWith(list).svc.list(ADMIN, query({ limit: 10, category: "problem" }), CTX);
    expect(list).toHaveBeenCalledWith({ category: "problem", workerId: undefined }, null, 11);
  });

  it("no category means NO filter — undefined, never a default of `other`", async () => {
    // A default here would silently hide every untagged submission, and most of them are
    // untagged: the shipped client omits the key entirely when the worker did not tag.
    const list = listSpy();
    await svcWith(list).svc.list(ADMIN, query({ limit: 10 }), CTX);
    expect(list).toHaveBeenCalledWith({ category: undefined, workerId: undefined }, null, 11);
  });

  it("the filter survives paging — page two is still narrowed", async () => {
    const list = listSpy(rows(4));
    const svc = svcWith(list).svc;
    const first = await svc.list(ADMIN, query({ limit: 3, category: "suggestion" }), CTX);
    await svc.list(ADMIN, query({ limit: 3, category: "suggestion", cursor: first.nextCursor! }), CTX);
    expect(list.mock.calls).toHaveLength(2);
    for (const call of list.mock.calls) expect(call[0]).toEqual({ category: "suggestion", workerId: undefined });
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
  function pagingRepo(data: AdminFeedbackRow[]): AdminFeedbackRepository {
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
    const svc = new AdminFeedbackService(pagingRepo(data), eventsStub().events, storageStub().storage, cfg());

    const seen: AdminFeedbackListItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.list(ADMIN, query({ limit: 3, cursor }), CTX);
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
    const svc = new AdminFeedbackService(pagingRepo(data), eventsStub().events, storageStub().storage, cfg());

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.list(ADMIN, query({ limit: 2, cursor }), CTX);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(data.map((r) => r.id));
  });

  it("the walk is genuinely multi-page (the fixture is not one page in disguise)", async () => {
    // Guards the two assertions above: if `pagingRepo` ever returned everything at once they
    // would still pass, and would be testing nothing.
    const svc = new AdminFeedbackService(pagingRepo(rows(20)), eventsStub().events, storageStub().storage, cfg());
    const first = await svc.list(ADMIN, query({ limit: 3 }), CTX);
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
    const svc = svcWith(list).svc;
    return { svc, list };
  }

  it("passes a well-formed uuid cursor straight through", async () => {
    const { svc, list } = serviceWithSpy();
    await svc.list(ADMIN, query({ cursor: cursorFor(VALID_TS, VALID_ID) }), CTX);
    expect(list.mock.calls[0]![1]).toEqual({ createdAt: VALID_TS, id: VALID_ID });
  });

  it.each([
    ["a non-uuid id", "x"],
    ["a truncated uuid", "3f2504e0-4f89-41d3-9a0c"],
    ["a uuid with a SQL fragment appended", `${VALID_ID}' or '1'='1`],
    ["an empty id", ""],
  ])("serves the FIRST page for %s", async (_label, id) => {
    const { svc, list } = serviceWithSpy();
    await svc.list(ADMIN, query({ cursor: cursorFor(VALID_TS, id) }), CTX);
    // null, not the bad cursor — the repository never sees a value it would bind against uuid.
    expect(list.mock.calls[0]![1]).toBeNull();
  });
});

/**
 * The audit of the read (ADR-0025 Amendment 1).
 *
 * ── WHAT IS ACTUALLY BEING DEFENDED ────────────────────────────────────────────────────
 * `GET /admin/feedback` is the ONE admin read that returns worker-authored prose, and it sits
 * on `read_entities` — the floor all four roles hold. `FeedbackService`'s own comment claims
 * the words are "one authenticated admin screen away, behind an audited surface"; before this
 * event that sentence was false. So there are three properties here, and each fails
 * differently:
 *
 *   1. IT EMITS AT ALL, once per read, with the filters and the count.
 *   2. IT FAILS CLOSED. An audit that is best-effort is not a control, it is a log line — so a
 *      failed emit must cost the caller the page, not be swallowed.
 *   3. IT CARRIES NO WORDS. Not the message, not an excerpt, not a length.
 */
describe("admin.feedback_viewed — the read leaves a trail", () => {
  it("emits exactly one event per read, from the SESSION admin", async () => {
    const { svc, emit } = svcWith(listSpy(rows(3)));
    await svc.list(ADMIN, query({ limit: 10 }), CTX);
    expect(emit).toHaveBeenCalledTimes(1);
    const evt = emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("admin.feedback_viewed");
    expect(evt.actor).toEqual({ actor_type: "admin", actor_id: ADMIN });
    expect(evt.correlationId).toBe(CTX.correlationId);
    expect(evt.requestId).toBe(CTX.requestId);
  });

  it("files the read under the ADMIN SESSION, never under a worker", async () => {
    // THE SUBJECT DECISION, pinned because it is the one a later change would "tidy". The
    // route's worker narrowing is an optional FILTER, not a path parameter, so a worker-axis
    // subject would make `subject_type=worker&subject_id=W` look like a complete record of who
    // read W's feedback while silently omitting every unfiltered page that contained it. A
    // uniform subject is honest about what the trail can answer; a per-request one is not.
    const { svc, emit } = svcWith(listSpy(rows(2)));
    await svc.list(ADMIN, query({ limit: 10, workerId: uuidFor(1000) }), CTX);
    expect(emit.mock.calls[0]![0].subject).toEqual({
      subject_type: "admin_session",
      subject_id: ADMIN,
    });
  });

  it("records the filters AS APPLIED, with null for 'no filter'", async () => {
    const worker = uuidFor(1000);
    const { svc, emit } = svcWith(listSpy(rows(2)));
    await svc.list(ADMIN, query({ limit: 10, workerId: worker, category: "problem" }), CTX);
    expect(emit.mock.calls[0]![0].payload).toEqual({
      admin_id: ADMIN,
      worker_id: worker,
      category: "problem",
      result_count: 2,
    });

    const unfiltered = svcWith(listSpy(rows(2)));
    await unfiltered.svc.list(ADMIN, query({ limit: 10 }), CTX);
    // Explicit nulls, not omitted keys: "read everyone's feedback" is a stronger fact than
    // "read one worker's", and it has to be legible on the row rather than inferred from a gap.
    expect(unfiltered.emit.mock.calls[0]![0].payload).toMatchObject({
      worker_id: null,
      category: null,
    });
  });

  it("counts the page RETURNED, never the over-fetched peek row", async () => {
    // The repository is asked for `limit + 1` to tell "there is more" from "that was the last
    // page". Auditing `rows.length` would claim the admin saw one message more than they did,
    // on every page but the last — a per-page overcount in an append-only audit record.
    const { svc, emit } = svcWith(listSpy(rows(6)));
    const page = await svc.list(ADMIN, query({ limit: 5 }), CTX);
    expect(page.items).toHaveLength(5);
    expect(emit.mock.calls[0]![0].payload).toMatchObject({ result_count: 5 });
  });

  it("counts zero for an empty page — a read that found nothing is still a read", async () => {
    const { svc, emit } = svcWith(listSpy());
    await svc.list(ADMIN, query({ limit: 10, workerId: uuidFor(9) }), CTX);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0].payload).toMatchObject({ result_count: 0 });
  });

  it("FAILS CLOSED — an emit failure denies the page rather than being swallowed", async () => {
    // The property that makes this a control instead of telemetry, and the same discipline
    // `AdminPiiRevealService` applies to its audit-before-decrypt. A caller that got the words
    // anyway would have read them with no trail, which is the exact gap this event closes.
    const { svc } = svcWith(listSpy(rows(3)), { emitThrows: true });
    await expect(svc.list(ADMIN, query({ limit: 10 }), CTX)).rejects.toThrow(
      "simulated emit failure",
    );
  });

  it("carries NO message text — not the words, not an excerpt, not a length", async () => {
    // The serialized scan is the assertion that matters: it catches the text arriving under ANY
    // field name, including one nobody has thought of yet. A LENGTH is refused too, and that is
    // deliberate rather than incidental — `feedback.submitted` carries one because it is the
    // shape of a submission the worker chose to make; a length here would be a fact about what
    // an admin was shown, adding nothing to `result_count` and starting the spine down the road
    // of describing content.
    const data = rows(3);
    data[0]!.message = "mera naam Ramesh hai, 9876543210 par call karo";
    const { svc, emit } = svcWith(listSpy(data));
    await svc.list(ADMIN, query({ limit: 10 }), CTX);
    const serialized = JSON.stringify(emit.mock.calls[0]![0]);
    expect(serialized).not.toContain("Ramesh");
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("message");
    expect(Object.keys(emit.mock.calls[0]![0].payload as object).sort()).toEqual([
      "admin_id",
      "category",
      "result_count",
      "worker_id",
    ]);
  });
});

describe("the worker filter reaches the repository verbatim", () => {
  it("forwards a requested workerId", async () => {
    const list = listSpy();
    const worker = uuidFor(1000);
    await svcWith(list).svc.list(ADMIN, query({ limit: 10, workerId: worker }), CTX);
    expect(list).toHaveBeenCalledWith({ category: undefined, workerId: worker }, null, 11);
  });

  it("combines with the category filter rather than replacing it", async () => {
    // Two independent narrowings. A repository call that dropped one would return a page the
    // URL does not describe, which is the exact failure `.strict()` on the DTO exists to prevent
    // one level up.
    const list = listSpy();
    const worker = uuidFor(1000);
    await svcWith(list).svc.list(
      ADMIN,
      query({ limit: 10, workerId: worker, category: "problem" }),
      CTX,
    );
    expect(list).toHaveBeenCalledWith({ category: "problem", workerId: worker }, null, 11);
  });

  it("survives paging — page two is still narrowed to the same worker", async () => {
    const list = listSpy(rows(4));
    const worker = uuidFor(1000);
    const { svc } = svcWith(list);
    const first = await svc.list(ADMIN, query({ limit: 3, workerId: worker }), CTX);
    await svc.list(ADMIN, query({ limit: 3, workerId: worker, cursor: first.nextCursor! }), CTX);
    expect(list.mock.calls).toHaveLength(2);
    for (const call of list.mock.calls) expect(call[0]).toMatchObject({ workerId: worker });
  });
});

/**
 * ── THE ATTACHMENTS (#1191) ──────────────────────────────────────────────────────────────
 *
 * Two properties, and they pull in opposite directions on purpose:
 *
 *   1. NO KEY EVER LEAVES. The repository hands the service stored object keys; the wire
 *      contract has no key-shaped field at all. A key is a durable handle to a worker's private
 *      photograph and would outlive every signed url minted for it.
 *   2. SIGNING FAILS OPEN. Everything else on this surface fails closed — the audit emit
 *      propagates, a bad cursor is refused. This one does not, because the MESSAGE is the
 *      feature and the images support it: a Storage blip must never cost an operator the
 *      complaint they came here to read.
 */
describe("attachment urls — minted per request, never the stored keys (#1191)", () => {
  /** `n` rows where row `i` carries `counts[i]` attachments. */
  function rowsWithAttachments(counts: number[]): AdminFeedbackRow[] {
    return rows(counts.length).map((r, i) => ({
      ...r,
      attachment_paths: Array.from({ length: counts[i]! }, (_, k) => pathFor(i * 10 + k)),
    }));
  }

  it("mints one short-lived signed url per stored key, in order", async () => {
    const data = rowsWithAttachments([2, 0]);
    const { svc, sign } = svcWith(listSpy(data));

    const page = await svc.list(ADMIN, query({ limit: 10 }), CTX);

    expect(page.items[0]!.attachment_urls).toHaveLength(2);
    expect(page.items[1]!.attachment_urls).toEqual([]);
    // The TTL is the resume download's, and the bucket is the attachments one — reusing a
    // long-lived TTL here would make "look at this row" and "keep these bytes" the same act.
    expect(sign.mock.calls[0]![1]).toBe(TTL);
    expect(sign.mock.calls[0]![2]).toBe(BUCKET);
    expect(page.items[0]!.attachment_urls[0]).toContain(data[0]!.attachment_paths[0]!);
  });

  it("asks the storage origin for Content-Disposition: attachment, named from OUR key", async () => {
    // Defence in depth: the bytes are worker-supplied, so a top-level click must download
    // rather than render them on the storage origin. The filename is the key's own basename —
    // a uuid this server minted — so no caller-chosen byte reaches it.
    const data = rowsWithAttachments([1]);
    const { svc, sign } = svcWith(listSpy(data));
    await svc.list(ADMIN, query({ limit: 10 }), CTX);

    const key = data[0]!.attachment_paths[0]!;
    expect(sign.mock.calls[0]![3]).toBe(key.slice(key.lastIndexOf("/") + 1));
    expect(sign.mock.calls[0]![3]).toMatch(/^[0-9a-f-]+\.jpg$/);
  });

  it("NEVER puts a stored key on the response", async () => {
    const data = rowsWithAttachments([3, 1]);
    const { svc } = svcWith(listSpy(data));

    const page = await svc.list(ADMIN, query({ limit: 10 }), CTX);

    for (const item of page.items) {
      expect(item).not.toHaveProperty("attachment_paths");
    }
  });

  it("serves the row with NO images when signing fails — the message still arrives", async () => {
    // THE FAIL-OPEN, and the only place on this surface that has one. A whole-page error over a
    // thumbnail would trade the thing that matters for the thing that supports it.
    const data = rowsWithAttachments([2, 2]);
    const doomed = data[0]!.attachment_paths[0]!;
    const { svc } = svcWith(listSpy(data), { signThrowsFor: (path) => path === doomed });

    const page = await svc.list(ADMIN, query({ limit: 10 }), CTX);

    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.message).toBe(data[0]!.message);
    // PER ROW, not per path: a partial list would show one of two images with nothing saying
    // the other existed, which is a quieter lie than an empty cell.
    expect(page.items[0]!.attachment_urls).toEqual([]);
    // ...and the failure is contained — the untouched row keeps its images.
    expect(page.items[1]!.attachment_urls).toHaveLength(2);
  });

  it("serves empty urls and touches storage NOT AT ALL while the bucket is unset", async () => {
    // The dormant deployment. Nothing could have been uploaded, so there is nothing to sign —
    // and no reason to log a failure once per row forever.
    const { svc, sign } = svcWith(listSpy(rowsWithAttachments([2])), { bucket: "" });
    const page = await svc.list(ADMIN, query({ limit: 10 }), CTX);
    expect(page.items[0]!.attachment_urls).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("does not sign the OVER-FETCHED row nobody will see", async () => {
    // The repository is asked for limit+1 to detect a next page. Signing the peeked row would
    // spend a Storage round trip on a row that is sliced off, on every full page.
    const { svc, sign } = svcWith(listSpy(rowsWithAttachments([1, 1, 1])));
    const page = await svc.list(ADMIN, query({ limit: 2 }), CTX);
    expect(page.items).toHaveLength(2);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("signs AFTER the audit — a url is never minted for a read whose trail did not commit", async () => {
    // The audit is the compensating control that makes this surface acceptable, and a signed
    // url is the most durable thing it hands out. Emit first, or hand out nothing.
    const { svc, sign } = svcWith(listSpy(rowsWithAttachments([2])), { emitThrows: true });
    await expect(svc.list(ADMIN, query(), CTX)).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });

  it("keeps urls and paths OFF the audit record", async () => {
    const data = rowsWithAttachments([2]);
    const { svc, emit } = svcWith(listSpy(data));
    await svc.list(ADMIN, query(), CTX);
    const serialized = JSON.stringify(emit.mock.calls[0]![0]);
    expect(serialized).not.toContain("feedback-attachments");
    expect(serialized).not.toContain("storage.test");
  });
});
