import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewWorkerAttribute } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { CITY_CATALOGUE } from "./worker-cities.catalogue";
import { SetMyPreferencesSchema } from "./worker-preferences.dto";
import { WorkerPreferencesService } from "./worker-preferences.service";
import { PREFERENCE_KEYS } from "./worker-preferences.vocabulary";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

/** A stored `worker_attributes` row, in the projection `loadKeys` returns. */
interface StoredRow {
  attributeKey: string;
  valueKind: string;
  valueBool: boolean | null;
  valueNumber: string | null;
  valueText: string | null;
  valueTextList: string[] | null;
}
const stored = (attributeKey: string, over: Partial<StoredRow>): StoredRow => ({
  attributeKey,
  valueKind: "text",
  valueBool: null,
  valueNumber: null,
  valueText: null,
  valueTextList: null,
  ...over,
});

function setup(nightShiftReady: boolean | null = null, storedRows: StoredRow[] = []) {
  // Typed explicitly — `vi.fn(async () => …)` infers a ZERO-ARG signature, so `calls[0][1]` is a
  // type error even though the call happens at runtime, and the suite goes green while tsc fails.
  const upsertMany = vi.fn(async (_rows: NewWorkerAttribute[]) => 0);
  const deleteKeys = vi.fn(async (_workerId: string, _keys: readonly string[]) => 0);
  // #1504 — the key-scoped read behind the GET and the old-build rule. Filters by key exactly as
  // the SQL `inArray` does; the repository test is what pins the SQL itself.
  const loadKeys = vi.fn(async (_workerId: string, keys: readonly string[]) =>
    storedRows.filter((r) => keys.includes(r.attributeKey)),
  );
  const emit = vi.fn(async (_event: { event_name: string; payload: unknown }) => undefined);
  const add = vi.fn(async (_name: string, _data: unknown) => undefined);
  const updateResumePrefs = vi.fn(async (_id: string, _patch: unknown) => ({ id: WORKER }));
  const svc = new WorkerPreferencesService(
    { upsertMany, deleteKeys, loadKeys } as never,
    {
      findById: async () => ({ id: WORKER, resumeNightShiftReady: nightShiftReady }),
      latestResume: async () => null,
      updateResumePrefs,
    } as never,
    { emit } as never,
    { add } as never,
  );
  return { svc, upsertMany, deleteKeys, loadKeys, emit, add, updateResumePrefs };
}

/** Every line the service's instance logger writes (the field-initialised Logger precedent). */
function captureLogger(svc: WorkerPreferencesService): string[] {
  const lines: string[] = [];
  const logger = (
    svc as unknown as { logger: { log: (m: string) => void; warn: (m: string) => void } }
  ).logger;
  logger.log = (m: string) => void lines.push(String(m));
  logger.warn = (m: string) => void lines.push(String(m));
  return lines;
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

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * #1504 — GET /workers/me/work-preferences, the prefill
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("reading the stored answers back (#1504)", () => {
  const FULL: StoredRow[] = [
    stored("languages", { valueKind: "text_list", valueTextList: [] }),
    stored("preferred_locations", { valueKind: "text_list", valueTextList: ["Faridabad"] }),
    stored("shift_preference", { valueText: "night" }),
    stored("relocation_willingness", { valueKind: "boolean", valueBool: true }),
    stored("accommodation_needed", { valueKind: "boolean", valueBool: false }),
    stored("salary_expected_max", { valueKind: "number", valueNumber: "25000" }),
    stored("education_year", { valueKind: "number", valueNumber: "2018" }),
    stored("education_council", { valueText: "ncvt" }),
  ];

  it("maps every storage key to its WIRE key, through the table the write uses", async () => {
    const { svc } = setup(null, FULL);
    const { values } = await svc.getForWorker(WORKER);
    // The three names that differ. A GET that returned `preferred_locations` would be a body the
    // `.strict()` PUT rejects outright.
    expect(values.preferred_cities).toEqual(["Faridabad"]);
    expect(values.shift).toBe("night");
    expect(values.willing_to_relocate).toBe(true);
    expect(values).not.toHaveProperty("preferred_locations");
    expect(values).not.toHaveProperty("shift_preference");
    expect(values).not.toHaveProperty("relocation_willingness");
    // `numeric` comes back from pg as text; the wire carries the number the PUT validates.
    expect(values.salary_expected_max).toBe(25000);
    expect(values.education_year).toBe(2018);
    expect(values.accommodation_needed).toBe(false);
    // EXACTLY the twelve answer keys — never `touched_only`, never a storage name.
    expect(Object.keys(values).sort()).toEqual(
      Object.keys(SetMyPreferencesSchema.shape)
        .filter((k) => k !== "touched_only")
        .sort(),
    );
  });

  it("keeps NULL (no stored row) apart from [] (a stored 'none of these')", async () => {
    // THE DISTINCTION THE PREFILL DEPENDS ON. Coalescing null to [] would make a new-build save of
    // an untouched page clear every list the worker never answered — the erase, rebuilt.
    const { svc } = setup(null, FULL);
    const { values } = await svc.getForWorker(WORKER);
    expect(values.languages).toEqual([]);
    expect(values.documents_ready).toBeNull();
    expect(values.job_type).toBeNull();
    expect(values.education_institute).toBeNull();
  });

  it("round-trips: the GET, parsed by the PUT schema and saved, changes nothing", async () => {
    const { svc } = setup(null, FULL);
    const { values, partial } = await svc.getForWorker(WORKER);
    expect(partial).toEqual([]);
    // What a new build sends for an unedited page: every key it holds a value for, no nulls.
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
    const dto = SetMyPreferencesSchema.parse({ ...body, touched_only: true });

    const save = setup(null, FULL);
    await save.svc.setForWorker(WORKER, dto, CTX);
    // `languages: []` IS a stored "none of these", so re-sending it clears a row that is already
    // absent — the only clear, and a no-op in the table. Nothing null became a clear.
    expect(save.deleteKeys.mock.calls[0]![1]).toEqual(["languages"]);
    const written = save.upsertMany.mock.calls[0]![0];
    expect(rowFor(written, "preferred_locations")?.valueTextList).toEqual(["Faridabad"]);
    expect(rowFor(written, "relocation_willingness")?.valueBool).toBe(true);
    expect(rowFor(written, "salary_expected_max")?.valueNumber).toBe("25000");
    expect(rowFor(written, "documents_ready")).toBeUndefined();
  });

  it("reads ONLY the page's twelve keys, and ignores any other row it is handed", async () => {
    const trade = stored("turning_machine", { valueText: "cnc_lathe" });
    const h = setup(null, [...FULL, trade]);
    // Defence in depth over the SQL predicate: even a repository that returned everything must not
    // put a trade attribute on this response.
    h.loadKeys.mockImplementationOnce(async () => [...FULL, trade]);
    const response = await h.svc.getForWorker(WORKER);
    expect(h.loadKeys.mock.calls[0]![1]).toEqual(Object.keys(PREFERENCE_KEYS));
    expect(JSON.stringify(response)).not.toContain("cnc_lathe");
    expect(JSON.stringify(response)).not.toContain("turning_machine");
  });

  it("withholds stored values that no longer validate, and REPORTS them per field", async () => {
    const cities = CITY_CATALOGUE.slice(0, 6).map((c) => c.value);
    const { svc } = setup(null, [
      stored("languages", { valueKind: "text_list", valueTextList: ["hindi", "klingon"] }),
      // Six valid cities plus one the gazetteer does not know: one invalid, one over the cap of 5.
      stored("preferred_locations", {
        valueKind: "text_list",
        valueTextList: [cities[0]!, "Nowhereville", ...cities.slice(1)],
      }),
      stored("shift_preference", { valueText: "swing" }),
      // A value in the wrong column for the key's kind reads as nothing, and is reported.
      stored("relocation_willingness", { valueKind: "text", valueText: "yes" }),
      stored("job_type", { valueText: "permanent" }),
    ]);
    const res = await svc.getForWorker(WORKER);
    expect(res.values.languages).toEqual(["hindi"]);
    expect(res.values.preferred_cities).toEqual(cities.slice(0, 5));
    expect(res.values.shift).toBeNull();
    expect(res.values.willing_to_relocate).toBeNull();
    expect(res.values.job_type).toBe("permanent");
    expect([...res.partial].sort()).toEqual(
      ["languages", "preferred_cities", "shift", "willing_to_relocate"].sort(),
    );
    expect(res.dropped_count).toBe(5);
    // And what it DID return is a body the PUT accepts — the property the withholding is for.
    const body = Object.fromEntries(Object.entries(res.values).filter(([, v]) => v !== null));
    expect(() => SetMyPreferencesSchema.parse(body)).not.toThrow();
  });

  it("emits NOTHING and logs counts only", async () => {
    const h = setup(null, FULL);
    const lines = captureLogger(h.svc);
    await h.svc.getForWorker(WORKER);
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.upsertMany).not.toHaveBeenCalled();
    expect(h.deleteKeys).not.toHaveBeenCalled();
    const joined = lines.join("\n");
    expect(joined).toContain("8 stored");
    for (const leak of ["Faridabad", "night", "25000", "ncvt"]) {
      expect(joined).not.toContain(leak);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * #1504 — old-build blank-save protection (owner ruling 2026-09-15)
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("an old build's defaults do not erase stored answers (#1504)", () => {
  /** EXACTLY what `TradeFormPreferences.toJson()` / `WorkPreferences.toUpdateBody()` send untouched. */
  const OLD_BUILD_DEFAULTS = {
    languages: [],
    documents_ready: [],
    preferred_cities: [],
    willing_to_relocate: false,
    accommodation_needed: false,
  };
  const STORED: StoredRow[] = [
    stored("languages", { valueKind: "text_list", valueTextList: ["hindi"] }),
    stored("documents_ready", { valueKind: "text_list", valueTextList: ["aadhaar"] }),
    stored("relocation_willingness", { valueKind: "boolean", valueBool: true }),
  ];

  it("leaves stored values alone where the old build sent a default, and writes real answers", async () => {
    const h = setup(null, STORED);
    await h.svc.setForWorker(WORKER, parse({ ...OLD_BUILD_DEFAULTS, shift: "night" }), CTX);
    // Stored languages/documents are NOT cleared; `preferred_cities` had nothing stored, so its
    // `[]` proceeds exactly as before (deleting nothing).
    expect(h.deleteKeys.mock.calls[0]![1]).toEqual(["preferred_locations"]);
    const written = h.upsertMany.mock.calls[0]![0];
    // The stored `true` is NOT flipped to false.
    expect(rowFor(written, "relocation_willingness")).toBeUndefined();
    // Nothing stored for accommodation, so the old behaviour stands.
    expect(rowFor(written, "accommodation_needed")?.valueBool).toBe(false);
    // A non-default value is an answer, and is written.
    expect(rowFor(written, "shift_preference")?.valueText).toBe("night");
    // The counts are what actually happened.
    expect(h.emit.mock.calls[0]![0].payload).toEqual({
      worker_id: WORKER,
      keys_written: 2,
      keys_cleared: 1,
    });
  });

  it("still writes a NON-default list over a stored one", async () => {
    const h = setup(null, STORED);
    await h.svc.setForWorker(WORKER, parse({ ...OLD_BUILD_DEFAULTS, languages: ["english"] }), CTX);
    expect(rowFor(h.upsertMany.mock.calls[0]![0], "languages")?.valueTextList).toEqual(["english"]);
    expect(h.deleteKeys.mock.calls[0]![1]).not.toContain("languages");
  });

  it("with touched_only: true the contract is STRICT — [] clears and false is written", async () => {
    const h = setup(null, STORED);
    await h.svc.setForWorker(WORKER, parse({ ...OLD_BUILD_DEFAULTS, touched_only: true }), CTX);
    expect(h.deleteKeys.mock.calls[0]![1]).toEqual([
      "languages",
      "documents_ready",
      "preferred_locations",
    ]);
    expect(rowFor(h.upsertMany.mock.calls[0]![0], "relocation_willingness")?.valueBool).toBe(false);
    // The strict path needs no read at all.
    expect(h.loadKeys).not.toHaveBeenCalled();
  });

  it("refuses touched_only: false — there is nothing for it to mean", () => {
    expect(() => parse({ touched_only: false })).toThrow();
    expect(() => parse({ touched_only: true })).not.toThrow();
  });

  it("does not read the store when the old build sent no default-valued key", async () => {
    const h = setup(null, STORED);
    await h.svc.setForWorker(WORKER, parse({ shift: "day" }), CTX);
    expect(h.loadKeys).not.toHaveBeenCalled();
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
