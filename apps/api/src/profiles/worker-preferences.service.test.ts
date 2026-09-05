import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewWorkerAttribute } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { SetMyPreferencesSchema } from "./worker-preferences.dto";
import { WorkerPreferencesService } from "./worker-preferences.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

function setup(nightShiftReady: boolean | null = null) {
  // Typed explicitly — `vi.fn(async () => …)` infers a ZERO-ARG signature, so `calls[0][1]` is a
  // type error even though the call happens at runtime, and the suite goes green while tsc fails.
  const upsertMany = vi.fn(async (_rows: NewWorkerAttribute[]) => 0);
  const deleteKeys = vi.fn(async (_workerId: string, _keys: readonly string[]) => 0);
  const emit = vi.fn(async (_event: { event_name: string; payload: unknown }) => undefined);
  const add = vi.fn(async (_name: string, _data: unknown) => undefined);
  const updateResumePrefs = vi.fn(async (_id: string, _patch: unknown) => ({ id: WORKER }));
  const svc = new WorkerPreferencesService(
    { upsertMany, deleteKeys } as never,
    {
      findById: async () => ({ id: WORKER, resumeNightShiftReady: nightShiftReady }),
      latestResume: async () => null,
      updateResumePrefs,
    } as never,
    { emit } as never,
    { add } as never,
  );
  return { svc, upsertMany, deleteKeys, emit, add, updateResumePrefs };
}

const parse = (body: unknown) => SetMyPreferencesSchema.parse(body);
const rowFor = (rows: NewWorkerAttribute[], key: string) =>
  rows.find((r) => r.attributeKey === key);

describe("the finishing form's closed-set page (R6 §4)", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("writes each answer with the storage kind its own vocabulary declares", async () => {
    await h.svc.setForWorker(
      WORKER,
      parse({
        languages: ["hindi", "haryanvi"],
        job_type: "permanent",
        willing_to_relocate: true,
      }),
      CTX,
    );
    const rows = h.upsertMany.mock.calls[0]![0];
    // `wa_value_present_chk` rejects a row whose `value_kind` disagrees with the populated
    // column, so a mismatch here is a 23514 at runtime and not a type error — which is exactly
    // why the kind is derived from the vocabulary rather than from the shape of the value.
    expect(rowFor(rows, "languages")).toMatchObject({
      valueKind: "text_list",
      valueTextList: ["hindi", "haryanvi"],
      valueText: null,
      valueBool: null,
    });
    expect(rowFor(rows, "job_type")).toMatchObject({
      valueKind: "text",
      valueText: "permanent",
      valueTextList: null,
    });
    expect(rowFor(rows, "relocation_willingness")).toMatchObject({
      valueKind: "boolean",
      valueBool: true,
      valueText: null,
    });
  });

  it("writes the SAME attribute key the universal pack writes, so the form is an answer", async () => {
    // Not a second, competing store: `wa_worker_key_uq` is per (worker, key), so the form's
    // answer upserts over the interview's rather than sitting beside it for the résumé mapper
    // to arbitrate. If this key ever drifts, a worker gets two shift answers and the sheet picks
    // one at random.
    await h.svc.setForWorker(WORKER, parse({ shift: "rotational" }), CTX);
    expect(rowFor(h.upsertMany.mock.calls[0]![0], "shift_preference")).toBeDefined();
  });

  it("marks a form write as deterministic, and leaves the pack provenance null", async () => {
    await h.svc.setForWorker(WORKER, parse({ shift: "day" }), CTX);
    const row = rowFor(h.upsertMany.mock.calls[0]![0], "shift_preference")!;
    // `source` answers "did a model contribute" — the form is worker chips, so `answer_map` is
    // the accurate value and `llm_parse` would be a lie. WHICH surface asked is carried by the
    // null pack and null session, which no other `answer_map` row has.
    expect(row.source).toBe("answer_map");
    expect(row.packId).toBeNull();
    expect(row.sessionId).toBeNull();
  });

  it("treats an ABSENT key as no change and an EMPTY list as a real answer", async () => {
    // The distinction the whole submit path turns on. A worker who never reached the languages
    // page must keep the languages he gave last time; a worker who cleared every chip is saying
    // "none of these", and the row has to go.
    await h.svc.setForWorker(WORKER, parse({ languages: [] }), CTX);
    expect(h.upsertMany.mock.calls[0]![0]).toEqual([]);
    expect(h.deleteKeys).toHaveBeenCalledWith(WORKER, ["languages"]);
  });

  it("clears a scalar answer with null rather than storing one", async () => {
    // `wa_value_present_chk` makes absence the only representation of "no answer", so un-ticking
    // has to delete. A null stored in `value_text` would be rejected by the constraint.
    await h.svc.setForWorker(WORKER, parse({ job_type: null, accommodation_needed: null }), CTX);
    expect(h.upsertMany.mock.calls[0]![0]).toEqual([]);
    expect(h.deleteKeys.mock.calls[0]![1]).toEqual(["job_type", "accommodation_needed"]);
  });

  it("emits an event carrying COUNTS and none of the answers", async () => {
    await h.svc.setForWorker(
      WORKER,
      parse({
        languages: ["hindi", "bhojpuri"],
        preferred_cities: ["Faridabad", "Gurugram"],
        documents_ready: [],
      }),
      CTX,
    );
    const event = h.emit.mock.calls[0]![0];
    expect(event.event_name).toBe("worker.preferences_recorded");
    const serialised = JSON.stringify(event.payload);
    // Each of these is a harmless closed-vocabulary label on its own. The SET is what narrows a
    // person, and the spine needs none of it.
    for (const leak of ["hindi", "bhojpuri", "Faridabad", "Gurugram"]) {
      expect(serialised).not.toContain(leak);
    }
    expect(event.payload).toEqual({ worker_id: WORKER, keys_written: 2, keys_cleared: 1 });
  });

  it("does not fail the worker's write when the re-render queue is down", async () => {
    const svc = new WorkerPreferencesService(
      { upsertMany: async () => 1, deleteKeys: async () => 0 } as never,
      {
        findById: async () => ({ id: WORKER }),
        latestResume: async () => {
          throw new Error("redis down");
        },
      } as never,
      { emit: async () => undefined } as never,
      { add: async () => undefined } as never,
    );
    // The answers are already committed by this point. Losing the re-render costs a stale PDF
    // until the next render; failing the request would lose the worker's taps.
    await expect(svc.setForWorker(WORKER, parse({ shift: "day" }), CTX)).resolves.toMatchObject({
      keys_written: 1,
    });
  });
});

describe("the form's contract", () => {
  it("refuses a slug the vocabulary does not know", () => {
    // The slug would be stored and then silently dropped at render: the worker taps a chip, sees
    // nothing on his sheet, and nothing logs a reason. Rejecting at the edge is what keeps the
    // two dictionaries — validation and printing — provably the same one.
    expect(() => parse({ languages: ["klingon"] })).toThrow();
    expect(() => parse({ shift: "swing" })).toThrow();
    expect(() => parse({ job_type: "freelance" })).toThrow();
  });

  it("accepts the four shift values, including the one the pack cannot produce", () => {
    // `rotational` is the form's addition and the ratified sheet's value. It is a different fact
    // from `any`: "any" is what a man will accept, "rotational" is what he works.
    for (const shift of ["day", "night", "rotational", "any"]) {
      expect(() => parse({ shift })).not.toThrow();
    }
  });

  it("canonicalises a city through the shared gazetteer", () => {
    // "gurgaon" and "Gurugram" must become one value or a printed sheet and a match query see
    // two different strings for one place.
    expect(parse({ preferred_cities: ["gurgaon", "Gurugram"] }).preferred_cities).toEqual([
      "Gurugram",
    ]);
  });

  it("REJECTS an unresolved city rather than dropping it", () => {
    // Dropping is the silent-truncation shape: three cities in, two on the sheet, no reason
    // given. Fail closed, and name the value so the client can say which one.
    expect(() => parse({ preferred_cities: ["Faridabad", "Nowhereville"] })).toThrow(
      /Nowhereville/,
    );
  });

  it("de-duplicates a multi-select without failing it", () => {
    expect(parse({ languages: ["hindi", "hindi", "english"] }).languages).toEqual([
      "hindi",
      "english",
    ]);
  });

  it("rejects unknown keys, so a client cannot smuggle a field past validation", () => {
    expect(() => parse({ languages: ["hindi"], salary_expected: 25000 })).toThrow();
  });

  it("accepts an entirely empty submission as a no-op", () => {
    // The form is one screen a worker can leave without answering anything, and a no-op must not
    // be an error.
    expect(() => parse({})).not.toThrow();
  });
});

describe("the shift answer seeds night-shift readiness (#1426)", () => {
  const submit = async (h: ReturnType<typeof setup>, shift: unknown) =>
    h.svc.setForWorker(WORKER, parse({ shift }), CTX);

  it("seeds TRUE from night, rotational and any", async () => {
    // Owner ruling 2026-09-05. `rotational` includes nights by definition and `any` says so
    // outright, so all three are the worker stating a willingness they have already stated.
    for (const shift of ["night", "rotational", "any"]) {
      const h = setup(null);
      await submit(h, shift);
      expect(h.updateResumePrefs, `shift=${shift}`).toHaveBeenCalledWith(WORKER, {
        resumeNightShiftReady: true,
      });
    }
  });

  it("seeds FALSE from day", async () => {
    // Safe to write because `false` PRINTS NOTHING on the résumé — it is the absence of the
    // clause, never a rendered "not willing" (see resume-render-input.ts). The worst case is a
    // day-shift worker who later ticks the box themselves.
    const h = setup(null);
    await submit(h, "day");
    expect(h.updateResumePrefs).toHaveBeenCalledWith(WORKER, { resumeNightShiftReady: false });
  });

  it("NEVER overwrites a worker who has already answered — in either direction", async () => {
    // THE REASON THE COLUMN HAD TO BECOME THREE-STATE. Under `NOT NULL DEFAULT false` this method
    // could not tell "never asked" from a deliberate "no", so every worker who revisited this
    // form with a night-ish shift would have had their own "no" silently flipped to yes — on a
    // claim that reaches employers.
    for (const existing of [true, false]) {
      const h = setup(existing);
      await submit(h, "night");
      expect(h.updateResumePrefs, `existing=${existing}`).not.toHaveBeenCalled();
    }
  });

  it("does nothing when the worker did not answer the shift question", async () => {
    // Absent = never reached the page; null = cleared the answer. Neither is a shift to derive
    // from, and neither may consume the worker's one chance at a seeded default.
    const h = setup(null);
    await h.svc.setForWorker(WORKER, parse({ job_type: "permanent" }), CTX);
    expect(h.updateResumePrefs).not.toHaveBeenCalled();

    const cleared = setup(null);
    await submit(cleared, null);
    expect(cleared.updateResumePrefs).not.toHaveBeenCalled();
  });

  it("does not fail the worker's submission when the seed write throws", async () => {
    // The preferences are already committed by this point. A derived default is a convenience;
    // losing the answers the worker actually typed to save it would not be.
    const h = setup(null);
    h.updateResumePrefs.mockRejectedValueOnce(new Error("db down"));
    await expect(submit(h, "night")).resolves.toMatchObject({ worker_id: WORKER });
    expect(h.upsertMany).toHaveBeenCalled();
  });
});
