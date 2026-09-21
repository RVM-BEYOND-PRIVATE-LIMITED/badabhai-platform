import "reflect-metadata";
import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../common/request-context";
import type { EmploymentSuggestion } from "./employment-suggestions";
import {
  SetMyEmploymentSchema,
  projectEmploymentForPut,
  type EmploymentView,
} from "./worker-employment.dto";
import {
  EmploymentCountMismatchError,
  type WorkerEmploymentEditRecord,
} from "./worker-employment.repository";
import { WorkerEmploymentService } from "./worker-employment.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

const EMPLOYER = "Sandhar Technologies Limited, Plant II";
/** A clip this worker owns. */
const VOICE_NOTE = "22222222-2222-4222-8222-222222222222";
/** A real note id belonging to SOMEBODY ELSE — the IDOR this route must refuse. */
const OTHERS_VOICE_NOTE = "33333333-3333-4333-8333-333333333333";

function setup(
  stintsUpdated = 1,
  latestResume: unknown = null,
  ownedNoteIds: string[] = [VOICE_NOTE],
) {
  // Typed explicitly. `vi.fn(async () => ...)` infers a ZERO-ARG signature, so `mock.calls[0][1]`
  // is a type error even though the call happens at runtime - the tests passed and tsc did not.
  type Row = {
    employerNameEnc: string;
    employerCity: string | null;
    durationStated: boolean;
    roles: readonly {
      roleLabel: string;
      startYm: string | null;
      endYm: string | null;
      workDone: string | null;
      workDoneVoiceNoteId: string | null;
    }[];
  };
  const replaceForWorker = vi.fn(async (_workerId: string, _rows: readonly Row[]) => ({
    replacedExisting: false,
  }));
  const emit = vi.fn(async (_event: { event_name: string; payload: unknown }) => undefined);
  const add = vi.fn(async (_name: string, _data: unknown) => undefined);
  // The fake ciphertext deliberately does NOT contain the plaintext. A stub like
  // `enc:${v}` would make the "no plaintext reaches the repository" assertion below pass
  // against a service that never encrypted at all.
  const encrypt = vi.fn(() => "CIPHERTEXT-TOKEN");
  // #1354 — the description-source write. Returns how many stints it updated; ZERO is the
  // not-this-worker's-employment answer, which the service must turn into a 404.
  const setPolishDeclined = vi.fn(async (_w: string, _e: string, _d: boolean) => stintsUpdated);
  // The ownership read behind the mic (§3 fail closed). Returns only the ids this worker owns,
  // exactly as the scoped SELECT does.
  const findOwnedVoiceNoteIds = vi.fn(
    async (_w: string, ids: readonly string[]) =>
      new Set(ids.filter((id) => ownedNoteIds.includes(id))),
  );
  const svc = new WorkerEmploymentService(
    { replaceForWorker, setPolishDeclined, findOwnedVoiceNoteIds } as never,
    {
      findById: async () => ({ id: WORKER }),
      latestResume: async () => latestResume,
      latestProfile: async () => undefined,
    } as never,
    { encrypt } as never,
    { emit } as never,
    { add } as never,
    { employmentSuggestionsForWorker: async () => [] } as never,
  );
  return { svc, replaceForWorker, emit, add, encrypt, setPolishDeclined, findOwnedVoiceNoteIds };
}

const entry = (over: Record<string, unknown> = {}) => ({
  employer_name: EMPLOYER,
  employer_city: "Manesar",
  employer_state: "Haryana",
  start_ym: "2022-04",
  end_ym: null,
  role_label: "CNC Turner",
  work_done: "Twin-spindle lathes on steering housings",
  ...over,
});

const parse = (employments: unknown[]) => SetMyEmploymentSchema.parse({ employments });

describe("the work-history writer (R4 Q1)", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("encrypts the employer name before it reaches the repository", async () => {
    await h.svc.replaceForWorker(WORKER, parse([entry()]), CTX);
    const written = h.replaceForWorker.mock.calls[0]![1];
    // The repository takes ciphertext and cannot encrypt. A repository that could encrypt is a
    // repository that could forget to.
    expect(h.encrypt).toHaveBeenCalledWith(EMPLOYER);
    expect(written[0]!.employerNameEnc).toBe("CIPHERTEXT-TOKEN");
    expect(JSON.stringify(written)).not.toContain("Sandhar Technologies Limited");
  });

  it("keeps the city in PLAINTEXT — it prints on the sheet and is not an identifier", async () => {
    await h.svc.replaceForWorker(WORKER, parse([entry()]), CTX);
    const written = h.replaceForWorker.mock.calls[0]![1];
    expect(written[0]!.employerCity).toBe("Manesar");
  });

  it("emits an event carrying NO employer name and NO city", async () => {
    await h.svc.replaceForWorker(WORKER, parse([entry(), entry({ start_ym: null })]), CTX);
    const event = h.emit.mock.calls[0]![0];
    expect(event.event_name).toBe("worker.employment_recorded");
    // The employer name IS the feature and is exactly what may not travel. The city does not
    // travel either: a city plus a worker id plus a date range narrows a person considerably.
    const serialised = JSON.stringify(event.payload);
    for (const leak of ["Sandhar", "Manesar", "Haryana", "2022-04", "CNC Turner"]) {
      expect(serialised).not.toContain(leak);
    }
    expect(event.payload).toEqual({
      worker_id: WORKER,
      employer_count: 2,
      durations_stated: 1,
      replaced_existing: false,
    });
  });

  it("derives duration_stated from the presence of a start month (§11 #3)", async () => {
    // "Kuch saal" has no start month, and the sheet must print the literal "duration not
    // stated" rather than estimating one. The DB check constraint refuses `true` without a
    // start, so deriving it is the only value that is both honest and legal.
    await h.svc.replaceForWorker(WORKER, parse([entry({ start_ym: null })]), CTX);
    const written = h.replaceForWorker.mock.calls[0]![1];
    expect(written[0]!.durationStated).toBe(false);
  });

  it("gives the single role the employment's own dates (the shorthand)", async () => {
    await h.svc.replaceForWorker(WORKER, parse([entry()]), CTX);
    const written = h.replaceForWorker.mock.calls[0]![1];
    // BYTE-IDENTICAL TO WHAT THE SHORTHAND ALWAYS PRODUCED (#1328's acceptance condition):
    // one role, carrying the employment's own dates.
    expect(written[0]!.roles).toHaveLength(1);
    expect(written[0]!.roles[0]).toMatchObject({ roleLabel: "CNC Turner", startYm: "2022-04" });
  });

  describe("promotions (#1328, unblocking #1313)", () => {
    const promoted = () => ({
      ...entry(),
      role_label: undefined,
      work_done: null,
      roles: [
        // Display order, most recent first — the order the reference sheet prints.
        {
          role_label: "CNC Setter-cum-Operator",
          start_ym: "2024-04",
          end_ym: null,
          work_done: "Setting and first-piece",
        },
        {
          role_label: "CNC Turner",
          start_ym: "2022-04",
          end_ym: "2024-03",
          work_done: "Production turning",
        },
      ],
    });

    it("writes every stint, in the order the worker gave them", async () => {
      await h.svc.replaceForWorker(WORKER, parse([promoted()]), CTX);
      const written = h.replaceForWorker.mock.calls[0]![1];
      expect(written[0]!.roles).toEqual([
        {
          roleLabel: "CNC Setter-cum-Operator",
          startYm: "2024-04",
          endYm: null,
          workDone: "Setting and first-piece",
          workDoneVoiceNoteId: null,
        },
        {
          roleLabel: "CNC Turner",
          startYm: "2022-04",
          endYm: "2024-03",
          workDone: "Production turning",
          workDoneVoiceNoteId: null,
        },
      ]);
    });

    it("carries the clip a stint's description was spoken into", async () => {
      const spoken = promoted() as { roles: Record<string, unknown>[] };
      spoken.roles[0]!.work_done_voice_note_id = VOICE_NOTE;
      await h.svc.replaceForWorker(WORKER, parse([spoken]), CTX);
      const written = h.replaceForWorker.mock.calls[0]![1];
      expect(written[0]!.roles[0]!.workDoneVoiceNoteId).toBe(VOICE_NOTE);
      // The stint the worker TYPED keeps a null, which is what distinguishes the two.
      expect(written[0]!.roles[1]!.workDoneVoiceNoteId).toBeNull();
    });

    it("keeps each stint's OWN dates rather than the employment's", async () => {
      // The whole signal a promotion produces. An inherited range would assert the worker held
      // the senior title for the entire tenure, which is exactly what a promotion did not do.
      await h.svc.replaceForWorker(WORKER, parse([promoted()]), CTX);
      const roles = h.replaceForWorker.mock.calls[0]![1][0]!.roles;
      expect(roles[0]!.startYm).toBe("2024-04");
      expect(roles[1]!.endYm).toBe("2024-03");
    });

    it("rejects an employment carrying BOTH shorthand and roles", () => {
      // The two would be free to disagree about what the worker did there, and nothing
      // downstream could say which one they meant.
      const both = { ...entry(), roles: [{ role_label: "CNC Turner" }] };
      expect(() => parse([both])).toThrow();
    });

    it("rejects an employment with neither", () => {
      const neither = { ...entry(), role_label: undefined };
      expect(() => parse([neither])).toThrow();
    });

    it("rejects employment-level work_done alongside roles", () => {
      // With `roles` it belongs on the stint that earned it; two homes for one fact is one too
      // many.
      const bad = { ...promoted(), work_done: "Production turning" };
      expect(() => parse([bad])).toThrow();
    });

    it("rejects a stint whose end precedes its start", () => {
      const bad = {
        ...promoted(),
        roles: [{ role_label: "X", start_ym: "2024-06", end_ym: "2024-01" }],
      };
      expect(() => parse([bad])).toThrow();
    });
  });

  it("accepts an EMPTY list as a real edit that clears the block", async () => {
    // UPDATED FOR #1504 (owner ruling 2026-09-15), deliberately: `[]` still clears, but only from a
    // client that sends `expected_existing_count` — a body without it is an old build, whose `[]`
    // is a tap-through and is passed down as `preserveWhenEmpty` (pinned in the #1504 block below).
    const result = await h.svc.replaceForWorker(
      WORKER,
      SetMyEmploymentSchema.parse({ employments: [], expected_existing_count: 2 }),
      CTX,
    );
    expect(result.employer_count).toBe(0);
    expect(h.replaceForWorker).toHaveBeenCalledWith(WORKER, [], {
      expectedExistingCount: 2,
      preserveWhenEmpty: false,
    });
  });

  it("does not fail the worker's write when the re-render queue is down", async () => {
    const svc = new WorkerEmploymentService(
      { replaceForWorker: async () => ({ replacedExisting: true }) } as never,
      {
        findById: async () => ({ id: WORKER }),
        latestResume: async () => {
          throw new Error("redis down");
        },
      } as never,
      { encrypt: () => "CIPHERTEXT-TOKEN" } as never,
      { emit: async () => undefined } as never,
      { add: async () => undefined } as never,
      { employmentSuggestionsForWorker: async () => [] } as never,
    );
    // The history is already committed by this point. Losing the re-render costs a stale PDF
    // until the next render; failing the request would lose the worker's typing.
    await expect(svc.replaceForWorker(WORKER, parse([entry()]), CTX)).resolves.toMatchObject({
      employer_count: 1,
    });
  });
});

describe("the form's contract", () => {
  it("caps the list at four, because the cap is a RENDER budget nothing below enforces", () => {
    // A fifth employer would be accepted, stored, and then silently dropped by the sheet —
    // the shape of failure §11 #7 exists to forbid.
    expect(() => parse([entry(), entry(), entry(), entry(), entry()])).toThrow();
    expect(() => parse([entry(), entry(), entry(), entry()])).not.toThrow();
  });

  it("takes a month, never a date", () => {
    expect(() => parse([entry({ start_ym: "2022-04-01" })])).toThrow();
    expect(() => parse([entry({ start_ym: "2022-13" })])).toThrow();
    expect(() => parse([entry({ start_ym: "2022-04" })])).not.toThrow();
  });

  it("rejects an end before the start", () => {
    expect(() => parse([entry({ start_ym: "2022-04", end_ym: "2021-04" })])).toThrow();
    expect(() => parse([entry({ start_ym: "2022-04", end_ym: "2022-04" })])).not.toThrow();
  });

  it("treats a null end as CURRENT, not as missing", () => {
    expect(() => parse([entry({ start_ym: "2022-04", end_ym: null })])).not.toThrow();
  });

  it("refuses a blank employer — §11 #4 says the field is never blank and never invented", () => {
    expect(() => parse([entry({ employer_name: "   " })])).toThrow();
    expect(() => parse([entry({ employer_name: "contract work" })])).not.toThrow();
  });

  it("rejects unknown keys, so a client cannot smuggle a field past validation", () => {
    expect(() => parse([{ ...entry(), employer_phone: "9876543210" }])).toThrow();
  });
});

/**
 * ═══ THE WORKER'S CHOICE OF DESCRIPTION SOURCE (#1354) ═══
 *
 * The mitigation for #1350's section-8 override. ADR-0039 is explicit that no test can assert
 * the absence of a plausible-but-false rewrite — only the worker can — so what is protected
 * here is their ability to say so, and the authorization on the one route that lets them.
 */
describe("choosing which description prints (#1354)", () => {
  const EMPLOYMENT = "33333333-3333-4333-8333-333333333333";

  it("records a refusal as declined, and re-renders so it reaches the PDF", async () => {
    // A worker choosing a description source always has a resume — that is the screen they are
    // on. With none, `enqueueRerender` correctly returns early and there is nothing to assert.
    const { svc, setPolishDeclined, add } = setup(1, { id: "res-1" });
    const out = await svc.setDescriptionSource(WORKER, EMPLOYMENT, { source: "own_words" }, CTX);
    expect(setPolishDeclined).toHaveBeenCalledWith(WORKER, EMPLOYMENT, true);
    expect(out.stints_updated).toBe(1);
    // The choice means nothing until it reaches the sheet the worker hands over.
    expect(add).toHaveBeenCalled();
  });

  it("puts the rewrite back when they change their mind", async () => {
    const { svc, setPolishDeclined } = setup();
    await svc.setDescriptionSource(WORKER, EMPLOYMENT, { source: "polished" }, CTX);
    expect(setPolishDeclined).toHaveBeenCalledWith(WORKER, EMPLOYMENT, false);
  });

  it("404s another worker's employment — no existence oracle", async () => {
    // Zero rows updated is what the repository returns when the id belongs to someone else OR
    // to nobody. A 403 would confirm the former, which is a read of another worker's history
    // by status code.
    const { svc } = setup(0);
    await expect(
      svc.setDescriptionSource(WORKER, EMPLOYMENT, { source: "own_words" }, CTX),
    ).rejects.toThrow(/not found/i);
  });

  it("emits nothing that identifies the employer or either text", async () => {
    const { svc, emit } = setup();
    await svc.setDescriptionSource(WORKER, EMPLOYMENT, { source: "own_words" }, CTX);
    const payload = JSON.stringify(emit.mock.calls.at(-1)?.[0]?.payload ?? {});
    for (const secret of [EMPLOYER, "Manesar", "Haryana", EMPLOYMENT]) {
      expect(payload).not.toContain(secret);
    }
  });
});

/**
 * THE MIC ON THE WORK-HISTORY PAGE — the clip must be the worker's OWN.
 *
 * The foreign key proves the note exists and nothing else, because `voice_notes.worker_id` is on
 * the other row. Ownership is therefore a service rule, and these are the tests that make it one.
 */
describe("a spoken work description", () => {
  const spokenEntry = (noteId: string) => entry({ work_done_voice_note_id: noteId });

  it("stores the clip id alongside the worker's own words", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse([spokenEntry(VOICE_NOTE)]), CTX);
    const written = h.replaceForWorker.mock.calls[0]![1];
    expect(written[0]!.roles[0]!.workDoneVoiceNoteId).toBe(VOICE_NOTE);
    // The transcript is still the answer of record — the id is evidence, never the value.
    expect(written[0]!.roles[0]!.workDone).toBe("Twin-spindle lathes on steering housings");
  });

  it("REFUSES another worker's clip, and writes nothing", async () => {
    const h = setup();
    await expect(
      h.svc.replaceForWorker(WORKER, parse([spokenEntry(OTHERS_VOICE_NOTE)]), CTX),
    ).rejects.toThrow(/not found/i);
    // Fail CLOSED: the whole submission is refused rather than the bad id being dropped, so a
    // worker never silently loses the employer they just typed.
    expect(h.replaceForWorker).not.toHaveBeenCalled();
  });

  it("404s rather than confirming the clip exists — no oracle", async () => {
    const h = setup();
    await expect(
      h.svc.replaceForWorker(WORKER, parse([spokenEntry(OTHERS_VOICE_NOTE)]), CTX),
    ).rejects.toThrow(/voice note not found/i);
  });

  it("checks ownership BEFORE the write, once, for every clip claimed", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse([spokenEntry(VOICE_NOTE)]), CTX);
    expect(h.findOwnedVoiceNoteIds).toHaveBeenCalledWith(WORKER, [VOICE_NOTE]);
    expect(h.findOwnedVoiceNoteIds.mock.invocationCallOrder[0]!).toBeLessThan(
      h.replaceForWorker.mock.invocationCallOrder[0]!,
    );
  });

  it("does not touch the ownership read when nobody used the mic", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse([entry()]), CTX);
    expect(h.findOwnedVoiceNoteIds).not.toHaveBeenCalled();
    expect(h.replaceForWorker.mock.calls[0]![1][0]!.roles[0]!.workDoneVoiceNoteId).toBeNull();
  });

  it("emits no clip id on the spine — it is worker-linked audio provenance", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse([spokenEntry(VOICE_NOTE)]), CTX);
    const payload = JSON.stringify(h.emit.mock.calls.at(-1)?.[0]?.payload ?? {});
    expect(payload).not.toContain(VOICE_NOTE);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * #1504 — GET /workers/me/employment, and the PUT's protections
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const READABLE_TOKEN = "ENC-READABLE-7f3a";
const UNREADABLE_TOKEN = "ENC-UNREADABLE-c91e";

function editRecord(over: Partial<WorkerEmploymentEditRecord> = {}): WorkerEmploymentEditRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    employerNameEnc: READABLE_TOKEN,
    employerCity: "Manesar",
    employerState: "Haryana",
    startYm: "2022-04",
    endYm: null,
    roles: [
      {
        roleLabel: "CNC Turner",
        startYm: "2022-04",
        endYm: null,
        workDone: "Twin-spindle lathes on steering housings",
        workDoneVoiceNoteId: VOICE_NOTE,
        workDonePolishDeclined: false,
        hasPolish: true,
      },
    ],
    ...over,
  };
}

function readSetup(
  records: WorkerEmploymentEditRecord[],
  opts: {
    resumeEmploymentSuggestions?: EmploymentSuggestion[];
    rawProfile?: unknown;
  } = {},
) {
  const loadForWorkerEdit = vi.fn(async (_w: string) => records);
  // The RÉSUMÉ read, present on the stub so a service that used it instead would still run — and
  // return rows WITHOUT the clip, which is exactly what the voice-note test below catches.
  const loadForResume = vi.fn(async (_w: string) =>
    records.map((r) => ({
      ...r,
      roles: r.roles.map(({ workDoneVoiceNoteId: _v, ...rest }) => rest),
    })),
  );
  const replaceForWorker = vi.fn(
    async (_w: string, _rows: readonly unknown[], _opts?: Record<string, unknown>) => ({
      replacedExisting: true,
      existingCount: 2,
      skipped: false,
      carriedUnreadable: 1,
    }),
  );
  const findOwnedVoiceNoteIds = vi.fn(
    async (_w: string, ids: readonly string[]) => new Set(ids.filter((id) => id === VOICE_NOTE)),
  );
  const decrypt = vi.fn((token: string) => {
    if (token === READABLE_TOKEN) return EMPLOYER;
    // A realistic failure message that CARRIES the token — the thing that must not reach a log.
    throw new Error(`unsupported state or unable to authenticate data: ${token}`);
  });
  const emit = vi.fn(async (_event: { event_name: string; payload: unknown }) => undefined);
  const employmentSuggestionsForWorker = vi.fn(
    async (_w: string) => opts.resumeEmploymentSuggestions ?? [],
  );
  const latestProfile = vi.fn(async (_w: string) =>
    "rawProfile" in opts ? ({ rawProfile: opts.rawProfile } as never) : undefined,
  );
  const svc = new WorkerEmploymentService(
    { loadForWorkerEdit, loadForResume, replaceForWorker, findOwnedVoiceNoteIds } as never,
    { findById: async () => ({ id: WORKER }), latestResume: async () => null, latestProfile } as never,
    { decrypt, encrypt: () => "CIPHERTEXT-TOKEN" } as never,
    { emit } as never,
    { add: async () => undefined } as never,
    { employmentSuggestionsForWorker } as never,
  );
  const lines: string[] = [];
  const logger = (
    svc as unknown as { logger: Record<"log" | "warn" | "error" | "debug", (m: string) => void> }
  ).logger;
  for (const level of ["log", "warn", "error", "debug"] as const) {
    logger[level] = (m: string) => void lines.push(String(m));
  }
  return {
    svc,
    loadForWorkerEdit,
    loadForResume,
    replaceForWorker,
    decrypt,
    emit,
    lines,
    employmentSuggestionsForWorker,
    latestProfile,
  };
}

describe("reading the worker's own history back (#1504)", () => {
  const TWO = [
    editRecord(),
    editRecord({ id: "55555555-5555-4555-8555-555555555555", employerNameEnc: UNREADABLE_TOKEN }),
  ];

  it("decrypts the employer name for the owner, and withholds + counts a row that will not decrypt", async () => {
    const h = readSetup(TWO);
    const res = await h.svc.getForWorker(WORKER);
    expect(h.loadForWorkerEdit).toHaveBeenCalledWith(WORKER);
    expect(res.employments).toHaveLength(1);
    expect(res.employments[0]!.employer_name).toBe(EMPLOYER);
    expect(res.employments[0]!.employment_id).toBe("44444444-4444-4444-8444-444444444444");
    expect(res.unreadable_count).toBe(1);
    // Never the ciphertext on the wire.
    expect(JSON.stringify(res)).not.toContain(READABLE_TOKEN);
  });

  it("never logs the employer name or either token, and emits nothing", async () => {
    const h = readSetup(TWO);
    await h.svc.getForWorker(WORKER);
    const joined = h.lines.join("\n");
    // Positive first, so the leak checks cannot pass against a service that logs nothing.
    expect(joined).toContain("1 readable, 1 unreadable");
    for (const leak of [EMPLOYER, "Sandhar", READABLE_TOKEN, UNREADABLE_TOKEN, "Manesar"]) {
      expect(joined).not.toContain(leak);
    }
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("uses the EDIT read, never the résumé read — the clip id survives GET → projection → PUT", async () => {
    const h = readSetup([editRecord()]);
    const res = await h.svc.getForWorker(WORKER);
    expect(h.loadForResume).not.toHaveBeenCalled();
    expect(res.employments[0]!.roles[0]!.work_done_voice_note_id).toBe(VOICE_NOTE);

    const body = SetMyEmploymentSchema.parse({
      employments: res.employments.map(projectEmploymentForPut),
      expected_existing_count: res.employments.length + res.unreadable_count,
    });
    await h.svc.replaceForWorker(WORKER, body, CTX);
    const written = h.replaceForWorker.mock.calls[0]![1] as {
      roles: { workDoneVoiceNoteId: string | null }[];
    }[];
    expect(written[0]!.roles[0]!.workDoneVoiceNoteId).toBe(VOICE_NOTE);
    expect(h.replaceForWorker.mock.calls[0]![2]).toEqual({
      expectedExistingCount: 1,
      preserveWhenEmpty: false,
    });
  });

  it("reports which text prints: a refusal wins, a rewrite is 'polished', none is null", async () => {
    const role = editRecord().roles[0]!;
    const h = readSetup([
      editRecord({
        roles: [
          { ...role, workDonePolishDeclined: true, hasPolish: true },
          { ...role, workDonePolishDeclined: false, hasPolish: true },
          { ...role, workDonePolishDeclined: false, hasPolish: false },
        ],
      }),
    ]);
    const { employments } = await h.svc.getForWorker(WORKER);
    expect(employments[0]!.roles.map((r) => r.description_source)).toEqual([
      "own_words",
      "polished",
      null,
    ]);
  });

  it("never carries the rewrite text onto the GET response, even if the stored row already has it (M4)", async () => {
    // `hasPolish`/`workDonePolishDeclined` say NOTHING about text — `descriptionSourceOf` can
    // legitimately return the literal string "polished" for a role that has a rewrite, and that
    // string appearing on the wire is correct, not a leak. To keep this test from tripping on
    // that legitimate value, the role below has no rewrite at all: `hasPolish: false` so
    // `description_source` comes back `null`, and the ONLY way "polished" or the rewrite text
    // could appear on the wire is if the service starts forwarding the extra field checked below.
    //
    // `WorkerEmploymentEditRecord["roles"]` has no text field for the rewrite — only the boolean
    // `hasPolish` — so a row that carries `workDonePolished` text is not constructible without
    // bypassing the type. That bypass belongs here, in the fixture, never in production code: it
    // stands in for a future change that threads the rewrite text into the interface (e.g. for a
    // "preview the rewrite" screen) without updating `getForWorker`'s explicit key list.
    const leakyRole = {
      ...editRecord().roles[0]!,
      hasPolish: false,
      workDonePolishDeclined: false,
      workDonePolished: "Operated CNC lathes.",
    } as unknown as WorkerEmploymentEditRecord["roles"][number];
    const h = readSetup([editRecord({ roles: [leakyRole] })]);

    const res = await h.svc.getForWorker(WORKER);
    const wire = JSON.stringify(res);

    expect(wire).not.toContain("Operated CNC lathes.");
    expect(wire).not.toContain("workDonePolished");
    expect(wire).not.toContain("polished");
  });
});

/**
 * Jobs never confirmed — from a résumé, from chat, or both — offered beside the stored history
 * (the ruling: "résumé-parsed jobs AND chat-described jobs prefill Work History rows; saved only
 * when the worker saves").
 */
describe("employment suggestions (résumé + chat)", () => {
  // A minimal `DraftProfile` (packages/ai-contracts/src/profile.ts) — every OTHER field on that
  // schema is `.default()`-ed, so this is all `chatEmploymentSuggestions` needs to parse.
  const chatDraft = (experiences: Record<string, unknown>[]) => ({ experiences });

  it("a settled chat session with two experience entries produces exactly two staged suggestions, source:'chat'", async () => {
    const h = readSetup([], {
      rawProfile: chatDraft([
        { role_label: "CNC Turner", duration_text: "2 saal", duration_months: 24, work_done: "Twin-spindle lathes" },
        { role_label: "Fitter", duration_text: null, duration_months: null, work_done: null },
      ]),
    });
    const { employment_suggestions } = await h.svc.getForWorker(WORKER);
    expect(employment_suggestions).toHaveLength(2);
    expect(employment_suggestions.every((s) => s.source === "chat")).toBe(true);
    expect(employment_suggestions.map((s) => s.values.role_label)).toEqual(["CNC Turner", "Fitter"]);
    // VACUITY CHECK: never an employer name — see `employment-suggestions.ts`'s own docblock for
    // why that is architectural, not a masking choice this test could fool by omission.
    expect(employment_suggestions.every((s) => s.values.employer_name === null)).toBe(true);
    expect(employment_suggestions[0]!.values.work_done).toBe("Twin-spindle lathes");
    expect(employment_suggestions[1]!.values.work_done).toBeNull();
  });

  it("an unparseable stored draft degrades to zero chat suggestions, never a throw", async () => {
    const h = readSetup([], { rawProfile: { experiences: "not an array" } });
    await expect(h.svc.getForWorker(WORKER)).resolves.toMatchObject({ employment_suggestions: [] });
  });

  it("no stored profile at all is zero chat suggestions", async () => {
    const h = readSetup([]); // no `rawProfile` key => latestProfile resolves undefined
    const { employment_suggestions } = await h.svc.getForWorker(WORKER);
    expect(employment_suggestions).toEqual([]);
  });

  it("a résumé suggestion AND a chat suggestion for a DIFFERENT job coexist distinctly — neither drops the other", async () => {
    const resumeSuggestion: EmploymentSuggestion = {
      source: "resume",
      values: {
        employer_name: "Sandhar Technologies",
        employer_city: null,
        role_label: "CNC Operator",
        start_ym: null,
        end_ym: null,
        work_done: null,
      },
    };
    const h = readSetup([], {
      resumeEmploymentSuggestions: [resumeSuggestion],
      rawProfile: chatDraft([
        { role_label: "Welder", duration_text: "1 saal", duration_months: 12, work_done: null },
      ]),
    });
    const { employment_suggestions } = await h.svc.getForWorker(WORKER);
    expect(employment_suggestions).toHaveLength(2);
    expect(employment_suggestions).toContainEqual(resumeSuggestion);
    expect(employment_suggestions).toContainEqual({
      source: "chat",
      values: {
        employer_name: null,
        employer_city: null,
        role_label: "Welder",
        start_ym: null,
        end_ym: null,
        work_done: null,
      },
    });
    // DISTINCT, NOT MERGED: two entries with two different sources, never one row picked over
    // the other.
    const sources = employment_suggestions.map((s) => s.source).sort();
    expect(sources).toEqual(["chat", "resume"]);
  });

  it("staging a suggestion writes no worker_employment row — getForWorker never calls the writer", async () => {
    const h = readSetup([], {
      resumeEmploymentSuggestions: [
        {
          source: "resume",
          values: {
            employer_name: "Sandhar Technologies",
            employer_city: null,
            role_label: "CNC Operator",
            start_ym: null,
            end_ym: null,
            work_done: null,
          },
        },
      ],
      rawProfile: chatDraft([{ role_label: "Welder", duration_text: null, duration_months: null, work_done: null }]),
    });
    await h.svc.getForWorker(WORKER);
    expect(h.replaceForWorker).not.toHaveBeenCalled();
  });

  it("PUT /workers/me/employment is unaffected by whether staged suggestions exist — same outcome, same #1504 count logic", async () => {
    const baseline = setup();
    // A résumé-suggestion reader that THROWS if the writer ever consults it. If
    // `replaceForWorker` accidentally read suggestions, this proves it by failing the write
    // instead of silently passing.
    const angrySuggestions = setup();
    (angrySuggestions.svc as unknown as { resumeSuggestions: unknown }).resumeSuggestions = {
      employmentSuggestionsForWorker: async () => {
        throw new Error("the writer must never call this");
      },
    };
    const body = parse([entry()]);
    const a = await baseline.svc.replaceForWorker(WORKER, body, CTX);
    const b = await angrySuggestions.svc.replaceForWorker(WORKER, body, CTX);
    expect(a).toEqual(b);
    expect(a).toEqual({ worker_id: WORKER, employer_count: 1 });
  });
});

describe("the projection rule from a GET row to a PUT entry (#1504)", () => {
  const view = (roles: EmploymentView["roles"]): EmploymentView => ({
    employment_id: "44444444-4444-4444-8444-444444444444",
    employer_name: EMPLOYER,
    employer_city: "Manesar",
    employer_state: "Haryana",
    start_ym: "2022-04",
    end_ym: null,
    roles,
  });
  const stint = (over: Partial<EmploymentView["roles"][number]> = {}) => ({
    role_label: "CNC Turner",
    start_ym: "2022-04",
    end_ym: null,
    work_done: "Production turning",
    work_done_voice_note_id: VOICE_NOTE,
    description_source: "polished" as const,
    ...over,
  });

  it("ONE stint spanning the employment → the shorthand, and it parses", () => {
    const entry = projectEmploymentForPut(view([stint()]));
    expect(entry).toMatchObject({ role_label: "CNC Turner", work_done_voice_note_id: VOICE_NOTE });
    expect(entry).not.toHaveProperty("roles");
    expect(() => SetMyEmploymentSchema.parse({ employments: [entry] })).not.toThrow();
  });

  it("one stint with its OWN dates → roles[], so the stint is not widened to the tenure", () => {
    const entry = projectEmploymentForPut(view([stint({ start_ym: "2023-01" })]));
    expect(entry).not.toHaveProperty("role_label");
    expect((entry.roles as { start_ym: string }[])[0]!.start_ym).toBe("2023-01");
    expect(() => SetMyEmploymentSchema.parse({ employments: [entry] })).not.toThrow();
  });

  it("a promotion → roles[] with each stint's dates and clip, and it parses", () => {
    const entry = projectEmploymentForPut(
      view([
        stint({ role_label: "Setter", start_ym: "2024-04" }),
        stint({ start_ym: "2022-04", end_ym: "2024-03", work_done_voice_note_id: null }),
      ]),
    );
    const parsed = SetMyEmploymentSchema.parse({ employments: [entry] });
    expect(parsed.employments[0]!.roles).toHaveLength(2);
    expect(parsed.employments[0]!.roles![0]!.work_done_voice_note_id).toBe(VOICE_NOTE);
  });

  it("drops employment_id and description_source — echoing a GET row is a 400 (.strict)", () => {
    const entry = projectEmploymentForPut(view([stint()]));
    expect(entry).not.toHaveProperty("employment_id");
    expect(JSON.stringify(entry)).not.toContain("description_source");
    const echoed = { ...view([stint()]) };
    expect(() => SetMyEmploymentSchema.parse({ employments: [echoed] })).toThrow();
  });
});

describe("PUT protections (#1504)", () => {
  it("maps a count mismatch from INSIDE the transaction to a 409, with no event", async () => {
    const h = readSetup([]);
    h.replaceForWorker.mockRejectedValueOnce(new EmploymentCountMismatchError(3, 2));
    await expect(
      h.svc.replaceForWorker(
        WORKER,
        SetMyEmploymentSchema.parse({ employments: [entry()], expected_existing_count: 2 }),
        CTX,
      ),
    ).rejects.toThrow(ConflictException);
    expect(h.emit).not.toHaveBeenCalled();
    // The warning carries counts, never the employer the body was about to write.
    expect(h.lines.join("\n")).not.toContain(EMPLOYER);
  });

  it("does not turn an unrelated repository failure into a 409", async () => {
    const h = readSetup([]);
    h.replaceForWorker.mockRejectedValueOnce(new Error("deadlock"));
    await expect(
      h.svc.replaceForWorker(WORKER, SetMyEmploymentSchema.parse({ employments: [entry()] }), CTX),
    ).rejects.toThrow("deadlock");
  });

  it("an OLD-BUILD [] over stored rows is a no-op: 200 with the stored count, no event", async () => {
    const h = readSetup([]);
    h.replaceForWorker.mockResolvedValueOnce({
      replacedExisting: false,
      existingCount: 3,
      skipped: true,
      carriedUnreadable: 0,
    });
    const out = await h.svc.replaceForWorker(WORKER, parse([]), CTX);
    expect(h.replaceForWorker.mock.calls[0]![2]).toEqual({
      expectedExistingCount: undefined,
      preserveWhenEmpty: true,
    });
    expect(out).toEqual({ worker_id: WORKER, employer_count: 3 });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.lines.join("\n")).toContain("old-build empty employment save ignored");
  });

  it("a NEW-BUILD [] asks the repository to clear, and records it", async () => {
    const h = readSetup([]);
    await h.svc.replaceForWorker(
      WORKER,
      SetMyEmploymentSchema.parse({ employments: [], expected_existing_count: 2 }),
      CTX,
    );
    expect(h.replaceForWorker.mock.calls[0]![2]).toEqual({
      expectedExistingCount: 2,
      preserveWhenEmpty: false,
    });
    expect(h.emit).toHaveBeenCalledOnce();
  });

  it("bounds expected_existing_count as a non-negative integer, and keeps it optional", () => {
    expect(() =>
      SetMyEmploymentSchema.parse({ employments: [], expected_existing_count: -1 }),
    ).toThrow();
    expect(() =>
      SetMyEmploymentSchema.parse({ employments: [], expected_existing_count: 1.5 }),
    ).toThrow();
    expect(
      SetMyEmploymentSchema.parse({ employments: [] }).expected_existing_count,
    ).toBeUndefined();
  });
});

describe("the spoken-description contract", () => {
  it("rejects a clip with no description — provenance for nothing", () => {
    expect(() => parse([entry({ work_done: null, work_done_voice_note_id: VOICE_NOTE })])).toThrow(
      /work_done_voice_note_id requires work_done/,
    );
  });

  it("rejects a clip at the employment level when roles are used", () => {
    expect(() =>
      parse([
        entry({
          role_label: undefined,
          work_done: null,
          work_done_voice_note_id: VOICE_NOTE,
          roles: [{ role_label: "CNC Turner", work_done: "Turning" }],
        }),
      ]),
    ).toThrow(/work_done_voice_note_id belongs on each role/);
  });

  it("defaults to null, so every client that predates the mic keeps working", () => {
    const parsed = parse([entry()]);
    expect(parsed.employments[0]!.work_done_voice_note_id).toBeNull();
  });
});
