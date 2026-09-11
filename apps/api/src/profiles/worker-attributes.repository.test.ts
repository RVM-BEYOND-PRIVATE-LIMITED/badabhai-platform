import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { type Database, type NewWorkerAttribute, workerAttributes } from "@badabhai/db";

import { WorkerAttributesRepository } from "./worker-attributes.repository";

/**
 * STRUCTURAL tests for the `worker_attributes` writer and its trade-sheet read, against a
 * capturing Drizzle chain compiled with `PgDialect` — no Postgres.
 *
 * WHY THE ASSERTIONS ARE ON COMPILED SQL. Every service above this file mocks the repository, so
 * each guarantee that lives in the STATEMENT is unfalsifiable from there: a fake can restate the
 * intended semantics and pass while the real SQL is wrong. The three guarantees this file exists
 * for are all of that kind.
 *
 *   1. `setTextPolishDeclined`'s WHERE is the AUTHZ. The attribute key arrives from the client
 *      (#1485's route takes it in the path), so dropping `worker_id` from the predicate turns a
 *      worker's own refusal into an IDOR that flips a flag on somebody else's answer — with a 200
 *      and an event saying it worked. Nothing above this layer reads the predicate.
 *
 *   2. The upsert's conflict SET decides whether a worker's REFUSAL survives a form re-submission.
 *      `value_text_polished` is cleared and `value_text_polished_declined` is not, and that
 *      asymmetry is the whole of #1485's durability: get the condition wrong and the next render
 *      silently rewrites the sentence he explicitly chose to keep.
 *
 *   3. `loadTradeSheet`'s third collection is what the render path gates on. A projection missing
 *      the column, or a set built only for rows that still carry a rewrite, reopens #1485 in the
 *      one state a refused row normally sits in.
 */

const dialect = new PgDialect();
const compile = (node: unknown): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(node as SQL);
  return { sql: q.sql, params: q.params };
};

const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKER = "22222222-2222-4222-8222-222222222222";
/** The one declinable key (#1485) — the fresher's single worker-written Zone 4 segment. */
const ITI_PROJECT_WORK = "iti_project_work";

/** Whether a statement ran on the transaction handle or on the bare connection. */
type Via = "db" | "tx";

interface SelectCall {
  kind: "select";
  via: Via;
  table: unknown;
  projection: Record<string, unknown>;
  where: unknown;
}
interface InsertCall {
  kind: "insert";
  via: Via;
  table: unknown;
  values: NewWorkerAttribute[];
  target?: unknown[];
  set?: Record<string, unknown>;
  returning?: Record<string, unknown>;
}
interface UpdateCall {
  kind: "update";
  via: Via;
  table: unknown;
  set: Record<string, unknown>;
  where?: unknown;
  returning?: Record<string, unknown>;
}
type Call = SelectCall | InsertCall | UpdateCall;

/**
 * A capturing mock of the three chains this repository uses:
 *   select(proj).from(t).where(c)                                   — awaited directly
 *   insert(t).values(rows).onConflictDoUpdate({target,set}).returning(p)
 *   update(t).set(v).where(c).returning(p)
 *
 * `returning` resolves to `opts.returning` synthetic rows, because both write methods report a
 * COUNT derived from that array and a test has to be able to drive it to zero (the 404 leg) and
 * to one without a database.
 */
function makeDb(opts: { rows?: Record<string, unknown>[]; returning?: number } = {}) {
  const calls: Call[] = [];
  const returned = Array.from({ length: opts.returning ?? 1 }, (_, i) => ({ id: `row-${i}` }));

  const makeOps = (via: Via) => ({
    select: (projection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: async (where: unknown): Promise<Record<string, unknown>[]> => {
          calls.push({ kind: "select", via, table, projection, where });
          return opts.rows ?? [];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: NewWorkerAttribute[]) => {
        const call: InsertCall = { kind: "insert", via, table, values };
        calls.push(call);
        return {
          onConflictDoUpdate: (conflict: { target: unknown[]; set: Record<string, unknown> }) => {
            call.target = conflict.target;
            call.set = conflict.set;
            return {
              returning: async (returning: Record<string, unknown>) => {
                call.returning = returning;
                return returned;
              },
            };
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const call: UpdateCall = { kind: "update", via, table, set };
        calls.push(call);
        return {
          where: (where: unknown) => {
            call.where = where;
            return {
              returning: async (returning: Record<string, unknown>) => {
                call.returning = returning;
                return returned;
              },
            };
          },
        };
      },
    }),
  });

  const db = {
    ...makeOps("db"),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(makeOps("tx")),
  } as unknown as Database;

  return { db, calls, repo: new WorkerAttributesRepository(db), tx: makeOps("tx") };
}

const updateCall = (calls: Call[]): UpdateCall | undefined =>
  calls.find((c): c is UpdateCall => c.kind === "update");
const insertCall = (calls: Call[]): InsertCall | undefined =>
  calls.find((c): c is InsertCall => c.kind === "insert");
const selectCall = (calls: Call[]): SelectCall | undefined =>
  calls.find((c): c is SelectCall => c.kind === "select");

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * setTextPolishDeclined — the WHERE is the authorization (#1485)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("WorkerAttributesRepository.setTextPolishDeclined — the predicate IS the authz", () => {
  async function decline(
    declined = true,
    workerId: string = WORKER,
    key: string = ITI_PROJECT_WORK,
    returning = 1,
  ) {
    const m = makeDb({ returning });
    const count = await m.repo.setTextPolishDeclined(workerId, key, declined);
    return { calls: m.calls, count };
  }

  it("updates worker_attributes and nothing else", async () => {
    const { calls } = await decline();
    expect(calls).toHaveLength(1);
    expect(updateCall(calls)?.table).toBe(workerAttributes);
  });

  it("binds ALL THREE of worker_id, attribute_key and value_kind='text', ANDed", async () => {
    // The worker_id predicate is the whole ownership check — there is no read-then-write above it.
    // A WHERE on attribute_key alone compiles, runs, returns 1 and flips the flag on whichever
    // worker happens to own that key: a 200 and an emitted event for an edit nobody made. The
    // exact param LIST is asserted rather than `toContain`, so a dropped leg cannot hide behind
    // the other two, and the `and` count proves the three were not collapsed or ORed together.
    const { calls } = await decline();
    const { sql, params } = compile(updateCall(calls)?.where);
    expect(params).toEqual([WORKER, ITI_PROJECT_WORK, "text"]);
    expect(sql).toContain('"worker_id"');
    expect(sql).toContain('"attribute_key"');
    expect(sql).toContain('"value_kind"');
    expect(sql.match(/ and /gi)).toHaveLength(2);
    expect(sql).not.toMatch(/ or /i);
  });

  it("binds the CALLER's worker id, not a constant — two callers compile two predicates", async () => {
    // The discriminating half of the assertion above: `params[0]` being the right uuid once could
    // also be a hard-coded literal or a stale closure. It has to follow the argument.
    const mine = await decline(true, WORKER);
    const theirs = await decline(true, OTHER_WORKER);
    expect(compile(updateCall(mine.calls)?.where).params[0]).toBe(WORKER);
    expect(compile(updateCall(theirs.calls)?.where).params[0]).toBe(OTHER_WORKER);
  });

  it("binds the CALLER's attribute key — a second declinable key must reach the statement", async () => {
    // `DECLINABLE_ATTRIBUTE_KEYS` is a one-entry list today and will not stay one. A predicate
    // that pinned `iti_project_work` would keep passing the suite above and silently decline the
    // wrong answer the day a second key is allowed through the route's validation pipe.
    const { calls } = await decline(true, WORKER, "work_environment");
    expect(compile(updateCall(calls)?.where).params[1]).toBe("work_environment");
  });

  it("sets the FLAG and leaves both text columns alone — declining must not destroy the rewrite", async () => {
    // THE REASON THIS IS A FLAG AND NOT A NULLED COLUMN. `value_text_polished` is what the
    // polisher reads: clearing it here would make a refusal indistinguishable from "not polished
    // yet", so the next render would rewrite the sentence the worker just refused, and changing
    // his mind back would cost another model call. `value_text` is the answer itself and is not
    // this route's to touch at all.
    //
    // The allow-list is the discriminating half: it fails both when a column is added to the SET
    // and when `valueTextPolishedDeclined` stops being written, so "does not touch value_text"
    // cannot pass vacuously on an empty SET.
    const { calls } = await decline(true);
    const set = updateCall(calls)!.set;
    expect(Object.keys(set).sort()).toEqual(["valueTextPolishedDeclined"]);
    expect(set.valueTextPolishedDeclined).toBe(true);
    expect(set).not.toHaveProperty("valueText");
    expect(set).not.toHaveProperty("valueTextPolished");
  });

  it("does NOT stamp updated_at — a refusal must not re-elect the pack the sheet is built from", async () => {
    // THE DEFECT THIS PINS, WHICH IS NOT ABOUT TIDINESS. `loadTradeSheet` resolves the sheet's
    // `packId` as the `pack_id` of the row with the greatest `updated_at` — its own docstring
    // calls that "the interview the worker actually just finished". A refusal is not an interview.
    //
    // Concretely: a worker answers `iti_project_work` as a turning fresher, is later profiled under
    // a second role pack that does not re-ask it (the ITI items are gated on that trade's tenure, so
    // stating experience suppresses them), leaving newer rows under the second pack. Stamping
    // `updated_at` here would make `PUT .../text-source` hand the OLD pack back to the renderer —
    // flipping `templateIdForPack` between classic and bb_trade, and re-resolving
    // `WORKSHOP_MACHINES` / `TRADE_TEST` / `TRAINING_LABEL` against the wrong trade. A route that
    // picks which of two sentences prints would be silently picking the trade.
    //
    // `saveAttributePolish` and #1354's `setPolishDeclined` both leave the column alone too, so
    // this also pins the three writers agreeing.
    const { calls } = await decline(true);
    expect(updateCall(calls)!.set).not.toHaveProperty("updatedAt");
  });

  it("writes FALSE when the worker changes his mind back to the polished text", async () => {
    // The route is a source SETTER, not a decline button: `source: "polished"` has to be able to
    // clear the flag. A repository that hard-coded `true` would make the refusal irreversible and
    // the second half of the endpoint a no-op that still answers `{ ok: true }`.
    const { calls } = await decline(false);
    expect(updateCall(calls)!.set.valueTextPolishedDeclined).toBe(false);
  });

  it("returns the ROW COUNT — zero is the 404, and it must not be a boolean in disguise", async () => {
    // The service turns 0 into NotFoundException and reports the count in its log; a
    // `updated.length > 0` coerced to a number would give the same answer for one row and lose the
    // distinction the caller is built on. Zero has to be reachable: it is what a worker naming a
    // key he never answered — or somebody else's key — gets, with no existence oracle either way.
    expect((await decline(true, WORKER, ITI_PROJECT_WORK, 0)).count).toBe(0);
    expect((await decline(true, WORKER, ITI_PROJECT_WORK, 1)).count).toBe(1);
  });

  it("asks the database to RETURN something, which is what makes a count possible at all", async () => {
    // Drizzle reports no affected-row count without `returning`; dropping it leaves the caller
    // with an empty array, every request a 404, and no way for a worker to refuse anything.
    expect(Object.keys(updateCall((await decline()).calls)!.returning!)).toEqual(["id"]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * upsertMany — the conflict SET, where a refusal either survives a re-submission or does not
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const textAnswer = (over: Partial<NewWorkerAttribute> = {}): NewWorkerAttribute =>
  ({
    workerId: WORKER,
    attributeKey: ITI_PROJECT_WORK,
    valueKind: "text",
    valueText: "lathe par shaft banaya tha, 20 micron tolerance",
    ...over,
  }) as NewWorkerAttribute;

describe("WorkerAttributesRepository.upsertMany — the conflict SET", () => {
  async function upsert(rows: NewWorkerAttribute[] = [textAnswer()], returning = 1) {
    const m = makeDb({ returning });
    const count = await m.repo.upsertMany(rows);
    return { calls: m.calls, count };
  }

  it("upserts on (worker_id, attribute_key) — the wa_worker_key_uq pair, not the primary key", async () => {
    const { calls } = await upsert();
    const call = insertCall(calls)!;
    expect(call.table).toBe(workerAttributes);
    expect(call.target).toHaveLength(2);
    expect(call.target![0]).toBe(workerAttributes.workerId);
    expect(call.target![1]).toBe(workerAttributes.attributeKey);
  });

  it("overwrites every value column from `excluded`, each under its OWN key", async () => {
    // Exactly this list, because `wa_value_present_chk` demands one populated column and the one
    // `value_kind` names: a column left stale from a previous answer of a different kind makes the
    // row unwritable. The mapping is also the kind of thing a copy-paste leaves half-edited — a
    // second `excluded.value_text` filed under `valueTextList` would compile, upsert and quietly
    // put a sentence where the mapper looks for an array.
    const set = insertCall((await upsert()).calls)!.set!;
    const excluded: Record<string, string> = {
      valueKind: "excluded.value_kind",
      valueBool: "excluded.value_bool",
      valueNumber: "excluded.value_number",
      valueText: "excluded.value_text",
      valueTextList: "excluded.value_text_list",
      source: "excluded.source",
      questionKey: "excluded.question_key",
      packId: "excluded.pack_id",
      packVersion: "excluded.pack_version",
      sessionId: "excluded.session_id",
    };
    for (const [key, rendered] of Object.entries(excluded)) {
      expect(compile(set[key]).sql).toBe(rendered);
    }
  });

  it("assigns EXACTLY the columns this upsert owns — a new column must be decided, not inherited", async () => {
    const set = insertCall((await upsert()).calls)!.set!;
    expect(Object.keys(set).sort()).toEqual([
      "packId",
      "packVersion",
      "questionKey",
      "sessionId",
      "source",
      "updatedAt",
      "valueBool",
      "valueKind",
      "valueNumber",
      "valueText",
      "valueTextList",
      "valueTextPolished",
      "valueTextPolishedDeclined",
    ]);
    // `$onUpdate` does not fire through `onConflictDoUpdate`, so this has to be an explicit stamp.
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it("CLEARS value_text_polished unconditionally — a re-answer drops the old rewrite", async () => {
    // No writer of this table ever sets the column, so `excluded` carries NULL. That is the whole
    // invalidation rule: a rewrite is of a SENTENCE, and carrying it forward would print last
    // week's English over this week's answer for one saved model call.
    const set = insertCall((await upsert()).calls)!.set!;
    const { sql } = compile(set.valueTextPolished);
    expect(sql).toBe("excluded.value_text_polished");
    // The discriminating half of the asymmetry below: this column has NO condition on it.
    expect(sql).not.toMatch(/case/i);
  });

  it("KEEPS value_text_polished_declined when the text is unchanged, via a CASE (the asymmetry)", async () => {
    // THE ASYMMETRY WITH THE TEST ABOVE IS THE POINT, not an inconsistency. The polish is derived
    // data worth one model call; the refusal is the worker's DECISION and is not re-earned. Both
    // branches of that are load-bearing:
    //
    //   unchanged text → keep the flag. Re-submitting the trade form without touching this answer
    //     is the ordinary way to reach this upsert. Clearing the flag here is #1354's defect
    //     arriving through a side door: `value_text_polished` is NULLed on the line above, a null
    //     polish is exactly what the polisher reads as "not done yet", so the next render rewrites
    //     the sentence the worker had refused and nothing reports it.
    //   changed text → reset it. A refusal is about a SENTENCE; an edited answer is a different
    //     sentence, arrives un-refused, and is re-polished for free.
    const set = insertCall((await upsert()).calls)!.set!;
    const { sql, params } = compile(set.valueTextPolishedDeclined);
    expect(sql).toMatch(/^CASE WHEN /i);
    expect(sql).toContain('"value_text"');
    expect(sql).toContain("excluded.value_text");
    // Nothing is bound: the comparison is column-to-`excluded`, never a value from the caller.
    expect(params).toEqual([]);

    // THEN carries the EXISTING flag. `excluded.value_text_polished_declined` is always false (no
    // writer sets it), so reading the flag from `excluded` would be `ELSE false` with extra steps
    // and would revoke every refusal on every re-submission.
    const then = /THEN(.*?)ELSE/is.exec(sql)?.[1] ?? "";
    expect(then).toContain("value_text_polished_declined");
    expect(then).not.toContain("excluded.");
  });

  it("compares with IS NOT DISTINCT FROM, never a bare `=` — both sides are nullable", async () => {
    // `value_text` is NULL on every non-text answer, and NULL = NULL is NULL, which this CASE
    // reads as the ELSE branch: a changed answer. A bare `=` therefore revokes the refusal on any
    // upsert where the column is null on both sides — silently, with no failing constraint and no
    // event, and the worker finds out when an employer reads the rewrite he had refused.
    const set = insertCall((await upsert()).calls)!.set!;
    const { sql } = compile(set.valueTextPolishedDeclined);
    expect(sql).toMatch(/"value_text"\s+IS NOT DISTINCT FROM\s+excluded\.value_text/i);
    expect(sql).not.toMatch(/"value_text"\s*=\s*excluded\.value_text/i);
  });

  it("falls back to FALSE, not to the flag — an edited answer arrives un-refused", async () => {
    // The ELSE is the half that makes the refusal text-keyed rather than row-keyed. `ELSE
    // <column>` would keep a refusal attached to a sentence the worker has since rewritten, and
    // that sentence would then never be polished at all.
    const set = insertCall((await upsert()).calls)!.set!;
    expect(compile(set.valueTextPolishedDeclined).sql).toMatch(/ELSE\s+false\s+END\s*$/i);
  });

  it("returns the number of rows written, and issues NO statement for an empty list", async () => {
    // A flush with nothing to write must not reach the database at all: Drizzle throws on an empty
    // `values` array, so an unguarded upsert is a 500 on the one path that had nothing to do.
    const empty = await upsert([]);
    expect(empty.calls).toEqual([]);
    expect(empty.count).toBe(0);
    const two = await upsert([textAnswer(), textAnswer({ attributeKey: "workplace_type" })], 2);
    expect(two.count).toBe(2);
  });

  it("writes through the TRANSACTION handle when one is passed", async () => {
    // The interview flush writes the profile and these attributes in one transaction. A statement
    // issued on the bare connection is outside that rollback, so a failed flush would leave a
    // worker whose attributes are the new ones and whose profile is the old.
    const m = makeDb();
    await m.repo.upsertMany([textAnswer()], m.tx as unknown as Database);
    expect(insertCall(m.calls)?.via).toBe("tx");

    const bare = makeDb();
    await bare.repo.upsertMany([textAnswer()]);
    expect(insertCall(bare.calls)?.via).toBe("db");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * loadTradeSheet — the third collection the render path gates on
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  attributeKey: ITI_PROJECT_WORK,
  valueKind: "text",
  valueBool: null,
  valueNumber: null,
  valueText: "kuch nhi banaya, bas knowledge he mujhe",
  valueTextPolished: null,
  valueTextPolishedDeclined: false,
  valueTextList: null,
  packId: "pack_cnc_turner",
  updatedAt: new Date("2026-09-10T08:00:00.000Z"),
  ...over,
});

describe("WorkerAttributesRepository.loadTradeSheet — the read behind the render", () => {
  async function load(rows: Record<string, unknown>[] = [], workerId: string = WORKER) {
    const m = makeDb({ rows });
    const result = await m.repo.loadTradeSheet(workerId);
    return { calls: m.calls, result };
  }

  it("reads worker_attributes in ONE statement scoped to this worker", async () => {
    // The only scoping there is: the table is not otherwise filtered, so a mis-bound predicate
    // composes someone else's trade answers onto this worker's sheet.
    const { calls } = await load();
    expect(calls).toHaveLength(1);
    const call = selectCall(calls)!;
    expect(call.table).toBe(workerAttributes);
    const { sql, params } = compile(call.where);
    expect(sql).toContain('"worker_id"');
    expect(params).toEqual([WORKER]);
  });

  it("binds the CALLER's worker id", async () => {
    // Discriminates the assertion above from a constant.
    const { calls } = await load([], OTHER_WORKER);
    expect(compile(selectCall(calls)?.where).params).toEqual([OTHER_WORKER]);
  });

  it("projects value_text_polished_declined — an unselected column is an undefined flag", async () => {
    // The gate reads this column. Left out of the projection it is `undefined` on every row, the
    // set comes back empty for everyone, and #1485 is reverted at the read with nothing failing:
    // no type error (the row type narrows from the projection), no constraint, no log.
    //
    // The list is exact so an over-wide projection fails too — the render path has no business
    // reading `source`, `session_id` or either timestamp beyond `updated_at`.
    const { calls } = await load([row()]);
    expect(Object.keys(selectCall(calls)!.projection).sort()).toEqual([
      "attributeKey",
      "packId",
      "updatedAt",
      "valueBool",
      "valueKind",
      "valueNumber",
      "valueText",
      "valueTextList",
      "valueTextPolished",
      "valueTextPolishedDeclined",
    ]);
  });

  it("returns a SPARSE set — the declined key is in it and the un-declined one is not", async () => {
    // Sparse is what lets every reader that predates refusals stay correct: membership means yes,
    // absence means no, and there is no third state to mishandle. A set built from every text row
    // (or one keyed on the flag's value rather than filtered by it) would gate the polish off for
    // workers who never refused anything — the whole fresher block would stop using the rewrite.
    const { result } = await load([
      row({ attributeKey: ITI_PROJECT_WORK, valueTextPolishedDeclined: true }),
      row({ attributeKey: "work_environment", valueTextPolishedDeclined: false }),
    ]);
    expect(result.declinedAttributes.has(ITI_PROJECT_WORK)).toBe(true);
    expect(result.declinedAttributes.has("work_environment")).toBe(false);
    expect([...result.declinedAttributes]).toEqual([ITI_PROJECT_WORK]);
  });

  it("records a declined key whose rewrite is GONE — the ordinary state of a refused row", async () => {
    // `declined = true, value_text_polished = NULL` is not an edge case, it is where a refused row
    // SETTLES: the upsert NULLs the polish on every re-answer while carrying the flag over
    // unchanged text. Gating the set on a present rewrite (`if (polished && declined)`) drops
    // exactly this row, and the polisher then treats the refused answer as unfinished work and
    // rewrites it again.
    const { result } = await load([
      row({ valueTextPolished: null, valueTextPolishedDeclined: true }),
    ]);
    expect(result.declinedAttributes.has(ITI_PROJECT_WORK)).toBe(true);
    // And the two collections stay independent: no rewrite means no entry in the polished map.
    expect(result.polishedAttributes).toEqual({});
    // The worker's own words are still the answer, under the answer's own key.
    expect(result.attributes[ITI_PROJECT_WORK]).toBe("kuch nhi banaya, bas knowledge he mujhe");
  });

  it("keeps a rewrite that was never refused out of the declined set (the #1476 reveal state)", async () => {
    // The mirror of the test above, and the case that proves the set is driven by the FLAG rather
    // than by the presence of a polish: a worker who has been shown the rewrite and said nothing
    // must still get it printed.
    const { result } = await load([
      row({ valueTextPolished: "Turned shafts to a 20-micron tolerance." }),
    ]);
    expect(result.polishedAttributes).toEqual({
      [ITI_PROJECT_WORK]: "Turned shafts to a 20-micron tolerance.",
    });
    expect(result.declinedAttributes.size).toBe(0);
  });

  it("reads the flag only on text answers, which is what the CHECK permits", async () => {
    // `wa_value_text_polished_declined_chk` makes a declined non-text row unwritable, so this
    // mirrors the constraint rather than inventing a rule: nothing rephrases a slug, so there is
    // nothing on one to refuse. A flag honoured on a `text_list` row would put a key in the set
    // that no polish path can ever clear.
    const { result } = await load([
      row({
        attributeKey: "tools_owned",
        valueKind: "text_list",
        valueText: null,
        valueTextList: ["vernier", "micrometer"],
        valueTextPolishedDeclined: true,
      }),
    ]);
    expect(result.declinedAttributes.size).toBe(0);
    expect(result.attributes.tools_owned).toEqual(["vernier", "micrometer"]);
  });

  it("returns all four collections, and an EMPTY set for a worker with no attributes", async () => {
    // Absence is the ordinary case for every worker who has not been interviewed, and the render
    // path destructures this shape unconditionally — a missing key there is a TypeError inside a
    // queue worker, which surfaces as a resume that never renders.
    const { result } = await load([]);
    expect(Object.keys(result).sort()).toEqual([
      "attributes",
      "declinedAttributes",
      "packId",
      "polishedAttributes",
    ]);
    expect(result.declinedAttributes).toBeInstanceOf(Set);
    expect(result.declinedAttributes.size).toBe(0);
    expect(result).toEqual({
      packId: null,
      attributes: {},
      polishedAttributes: {},
      declinedAttributes: new Set(),
    });
  });
});
