import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../common/request-context";
import { SetMyQualificationsSchema } from "./worker-qualifications.dto";
import { WorkerQualificationsService } from "./worker-qualifications.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

/**
 * DISTINCTIVE, so a leak assertion cannot pass by accident. These strings appear nowhere else in
 * the payload, the ids or the log format, so `not.toContain` fails if and only if the value
 * itself travelled.
 */
const CERT_NAME = "CNC Turning & Fanuc Programming";
const ISSUER = "RVM CAD Training Centre";
const INSTITUTE = "Govt. ITI, Faridabad";
const FIELD = "Machinist";

/** The repository's input, restated for the stub only — the service is checked against the real one. */
interface RepoInput {
  readonly certificates?: readonly { name: string; issuer: string | null; year: number | null }[];
  readonly educations?: readonly {
    credential: string | null;
    field: string | null;
    council: string | null;
    year: number | null;
    institute: string | null;
  }[];
}

interface EmittedEvent {
  event_name: string;
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  correlationId: string;
  requestId: string;
}

interface RenderJob {
  resumeId: string;
  workerId: string;
  force?: boolean;
  failClosed?: boolean;
  correlationId?: string;
  requestId?: string;
}

function setup(
  opts: {
    workerMissing?: boolean;
    latestResume?: { id: string } | null;
    latestResumeThrows?: boolean;
    addThrows?: boolean;
    replacedExisting?: boolean;
  } = {},
) {
  // Every stub is typed EXPLICITLY. `vi.fn(async () => ...)` infers a ZERO-ARG signature, so
  // `mock.calls[0][1]` is a tsc error while vitest stays green — the tests pass and the
  // typecheck does not.
  const replaceForWorker = vi.fn(async (_workerId: string, input: RepoInput) => ({
    certificatesWritten: input.certificates?.length ?? 0,
    educationsWritten: input.educations?.length ?? 0,
    replacedExisting: opts.replacedExisting ?? false,
  }));
  const findById = vi.fn(async (_id: string) =>
    opts.workerMissing === true ? undefined : { id: WORKER },
  );
  const latestResume = vi.fn(async (_id: string) => {
    if (opts.latestResumeThrows === true) throw new Error("redis down");
    return opts.latestResume ?? undefined;
  });
  const emit = vi.fn(async (_event: EmittedEvent) => undefined);
  const add = vi.fn(async (_name: string, _data: RenderJob): Promise<void> => {
    if (opts.addThrows === true) throw new Error("redis down");
  });

  // Positional, deliberately. A Nest testing module resolves every dependency it does not know
  // about as `undefined` and the suite passes regardless of the constructor's real shape.
  const svc = new WorkerQualificationsService(
    { replaceForWorker } as never,
    { findById, latestResume } as never,
    { emit } as never,
    { add } as never,
  );
  return { svc, replaceForWorker, findById, latestResume, emit, add };
}

/**
 * Every line the service's INSTANCE logger writes. The class-level `Logger` is constructed in a
 * field initialiser, so it can only be captured on a built service — the resume-render processor
 * test does the same for the same reason.
 */
function captureLogger(svc: WorkerQualificationsService): string[] {
  const lines: string[] = [];
  const logger = (
    svc as unknown as { logger: { log: (m: string) => void; warn: (m: string) => void } }
  ).logger;
  logger.log = (m: string) => void lines.push(String(m));
  logger.warn = (m: string) => void lines.push(String(m));
  return lines;
}

const certificate = (over: Record<string, unknown> = {}) => ({
  name: CERT_NAME,
  issuer: ISSUER,
  year: 2019,
  ...over,
});

const education = (over: Record<string, unknown> = {}) => ({
  credential: "iti",
  field: FIELD,
  council: "ncvt",
  year: 2018,
  institute: INSTITUTE,
  ...over,
});

/** Parsed through the REAL schema, so the service is exercised on the shape the route hands it. */
const parse = (body: Record<string, unknown>) => SetMyQualificationsSchema.parse(body);

describe("the qualifications writer — the worker must exist first", () => {
  it("404s an unknown worker and writes NOTHING", async () => {
    // The repository's insert has an FK to `workers`, so a missing worker would fail anyway —
    // but as a 500 with a constraint name in it, after the event had already been emitted.
    const h = setup({ workerMissing: true });
    await expect(
      h.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX),
    ).rejects.toThrow(NotFoundException);
    expect(h.replaceForWorker).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });
});

describe("the qualifications writer — the three-state contract survives the service", () => {
  it("FORWARDS an absent list as `undefined`, never as `[]`", async () => {
    // THE bug this test exists for: `dto.certificates ?? []` here reads as harmless tidying and
    // silently wipes every certificate a worker has, the first time a client saves only the
    // education half of the page. The repository can only honour the three states if it is
    // told which one it was given.
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse({ educations: [education()] }), CTX);
    const input = h.replaceForWorker.mock.calls[0]![1];
    expect(input.certificates).toBeUndefined();
    expect(input.educations).toHaveLength(1);
  });

  it("FORWARDS an absent education list as `undefined` too", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX);
    expect(h.replaceForWorker.mock.calls[0]![1].educations).toBeUndefined();
  });

  it("forwards `[]` AS `[]` — 'I have none' must reach the repository as an answer", async () => {
    // The other half of the same contract. Dropping the empty array would make a worker's
    // deletion a no-op: they tap Save, see success, and the old rows are still on the sheet.
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse({ certificates: [], educations: [] }), CTX);
    const input = h.replaceForWorker.mock.calls[0]![1];
    expect(input.certificates).toEqual([]);
    expect(input.educations).toEqual([]);
  });

  it("passes every field through to the repository unchanged", async () => {
    // The service composes nothing — no defaults, no derivation, no expansion. §8: every printed
    // character is the worker's own.
    const h = setup();
    await h.svc.replaceForWorker(
      WORKER,
      parse({ certificates: [certificate()], educations: [education()] }),
      CTX,
    );
    const input = h.replaceForWorker.mock.calls[0]![1];
    expect(input.certificates![0]).toEqual({ name: CERT_NAME, issuer: ISSUER, year: 2019 });
    expect(input.educations![0]).toEqual({
      credential: "iti",
      field: FIELD,
      council: "ncvt",
      year: 2018,
      institute: INSTITUTE,
    });
  });

  it("returns the counts the repository actually wrote", async () => {
    const h = setup();
    const out = await h.svc.replaceForWorker(
      WORKER,
      parse({
        certificates: [certificate(), certificate({ name: "Wireman Licence" })],
        educations: [],
      }),
      CTX,
    );
    expect(out).toEqual({ worker_id: WORKER, certificate_count: 2, education_count: 0 });
  });
});

describe("the qualifications writer — the event carries counts and nothing else", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup({ replacedExisting: true });
  });

  it("emits worker.qualifications_recorded with EXACTLY the four count fields", async () => {
    await h.svc.replaceForWorker(
      WORKER,
      parse({ certificates: [certificate()], educations: [education()] }),
      CTX,
    );
    const event = h.emit.mock.calls[0]![0];
    expect(event.event_name).toBe("worker.qualifications_recorded");
    // `toEqual`, not `toMatchObject`: the whole guarantee is that nothing EXTRA is in the
    // payload, and `toMatchObject` passes on a payload that also carries the institute.
    expect(event.payload).toEqual({
      worker_id: WORKER,
      certificate_count: 1,
      education_count: 1,
      replaced_existing: true,
    });
  });

  it("puts no certificate name, issuer, institute or field anywhere in the event", async () => {
    // A council slug alone would be harmless; the SET is not. An institute plus a year plus a
    // worker id narrows a person considerably, and the spine only needs to know the page was
    // answered — not what it said. The whole emitted params object is serialised, so a leak into
    // `actor`, `subject` or a stray key fails this too.
    await h.svc.replaceForWorker(
      WORKER,
      parse({ certificates: [certificate()], educations: [education()] }),
      CTX,
    );
    const serialised = JSON.stringify(h.emit.mock.calls[0]![0]);
    for (const leak of [CERT_NAME, ISSUER, INSTITUTE, FIELD, "2018", "2019"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("reports replaced_existing from the repository, not from the request", async () => {
    // Only the transaction can know whether rows were there to replace. A service that guessed
    // from the submitted list would call every first-time save a replacement.
    const fresh = setup({ replacedExisting: false });
    await fresh.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX);
    expect(fresh.emit.mock.calls[0]![0].payload.replaced_existing).toBe(false);
  });

  it("emits only AFTER the write succeeded", async () => {
    // Event First means the event is the audit trail, and an audit trail that records writes
    // that did not happen is worse than none. A repository failure must take the event with it.
    const h2 = setup();
    h2.replaceForWorker.mockRejectedValueOnce(new Error("deadlock"));
    await expect(
      h2.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX),
    ).rejects.toThrow("deadlock");
    expect(h2.emit).not.toHaveBeenCalled();
  });
});

describe("the qualifications writer — the log line", () => {
  it("logs the counts and none of the credentials", async () => {
    const h = setup();
    const lines = captureLogger(h.svc);
    await h.svc.replaceForWorker(
      WORKER,
      parse({ certificates: [certificate()], educations: [education()] }),
      CTX,
    );
    const joined = lines.join("\n");
    // Asserted POSITIVELY first, so the leak check below cannot pass vacuously against a service
    // that logs nothing at all.
    expect(joined).toContain("1 certificate(s)");
    expect(joined).toContain("1 education(s)");
    for (const leak of [CERT_NAME, ISSUER, INSTITUTE, FIELD]) {
      expect(joined).not.toContain(leak);
    }
  });

  it("keeps the credentials out of the queue-failure warning too", async () => {
    // The unhappy path is where PII usually escapes: an error line built by interpolating "the
    // thing we were working on". This one may name the worker id and the driver's message only.
    const h = setup({ latestResume: { id: "res-1" }, addThrows: true });
    const lines = captureLogger(h.svc);
    await h.svc.replaceForWorker(
      WORKER,
      parse({ certificates: [certificate()], educations: [education()] }),
      CTX,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("could not enqueue");
    for (const leak of [CERT_NAME, ISSUER, INSTITUTE, FIELD]) {
      expect(joined).not.toContain(leak);
    }
  });
});

describe("the qualifications writer — the re-render", () => {
  it("re-renders the worker's existing resume IN PLACE, force and fail-open", async () => {
    // Zone 5 is baked into the PDF at render time, so without this an EDIT never reaches the
    // sheet the worker hands over. `force` is what defeats the processor's skip-if-rendered
    // idempotency; `failClosed: false` is right because ADDING a credential is not a REMOVAL —
    // a failed render must leave the previous PDF in service rather than 409 a resume the
    // worker had a second ago.
    const h = setup({ latestResume: { id: "res-1" } });
    await h.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX);
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.add.mock.calls[0]![0]).toBe("render");
    expect(h.add.mock.calls[0]![1]).toEqual({
      resumeId: "res-1",
      workerId: WORKER,
      force: true,
      failClosed: false,
      correlationId: "corr",
      requestId: "req",
    });
  });

  it("enqueues NOTHING when the worker has no resume yet, and does so QUIETLY", async () => {
    // The ordinary case: the form runs straight after the interview and before the first
    // generate, and that render picks these rows up on its own. Enqueuing against no resume id
    // would be a job that can only fail.
    const h = setup({ latestResume: null });
    const lines = captureLogger(h.svc);
    await h.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX);
    expect(h.add).not.toHaveBeenCalled();
    // A CLEAN early return, not a swallowed crash. Deleting the `if (!latest) return` guard also
    // leaves `add` uncalled — `latest.id` throws a TypeError and the best-effort catch absorbs it
    // — so "no job was enqueued" on its own cannot tell the ordinary case from a service that
    // warns on every save a resume-less worker makes.
    expect(lines.join("\n")).not.toContain("could not enqueue");
  });

  it("does not fail the worker's write when the queue is down", async () => {
    // The credentials are already committed by this point. Losing the re-render costs a stale
    // PDF until the next render; failing the request would lose the worker's typing.
    const h = setup({ latestResume: { id: "res-1" }, addThrows: true });
    await expect(
      h.svc.replaceForWorker(WORKER, parse({ certificates: [certificate()] }), CTX),
    ).resolves.toEqual({ worker_id: WORKER, certificate_count: 1, education_count: 0 });
    expect(h.emit).toHaveBeenCalledOnce();
  });

  it("does not fail the worker's write when the resume lookup itself throws", async () => {
    // Same contract one call earlier. The lookup is inside the same try for a reason: a database
    // hiccup reading `generated_resumes` must not undo a write that already succeeded.
    const h = setup({ latestResumeThrows: true });
    await expect(
      h.svc.replaceForWorker(WORKER, parse({ educations: [education()] }), CTX),
    ).resolves.toMatchObject({ education_count: 1 });
    expect(h.add).not.toHaveBeenCalled();
  });
});

describe("the qualifications form's contract", () => {
  it("refuses an empty body — `{}` and `{certificates: []}` mean opposite things", () => {
    // A client that sends neither key has lost track of which it meant. Absorbing it silently is
    // how a worker taps Save, sees success, and finds nothing changed.
    expect(() => parse({})).toThrow();
    expect(() => parse({ certificates: [] })).not.toThrow();
  });

  it("keeps an absent key ABSENT after parsing, rather than defaulting it", () => {
    // The service can only forward `undefined` if the schema hands it `undefined`. A `.default([])`
    // on either list would move the wipe-on-partial-save bug one file upstream and out of reach
    // of every service test.
    const parsed = parse({ educations: [education()] });
    expect(parsed.certificates).toBeUndefined();
    expect("certificates" in parsed).toBe(false);
  });

  it("caps each list, so the degradation ladder never sees forty values", () => {
    expect(() => parse({ certificates: Array.from({ length: 9 }, () => certificate()) })).toThrow();
    expect(() =>
      parse({ certificates: Array.from({ length: 8 }, () => certificate()) }),
    ).not.toThrow();
    expect(() => parse({ educations: Array.from({ length: 5 }, () => education()) })).toThrow();
  });

  it("refuses an education row with all five segments null", () => {
    // `wed_not_empty_chk` refuses to store one; rejecting here is what keeps a CHECK violation —
    // a 500 with a constraint name in it — off a worker's screen.
    expect(() =>
      parse({
        educations: [{ credential: null, field: null, council: null, year: null, institute: null }],
      }),
    ).toThrow();
  });

  it("takes a council SLUG, never its printed label", () => {
    // The dictionary is the only place an option's English lives, so relabelling costs an edit
    // rather than a backfill — and a stored label would stop printing the day one changes.
    expect(() => parse({ educations: [education({ council: "NCVT" })] })).toThrow();
    expect(() => parse({ educations: [education({ council: "ncvt" })] })).not.toThrow();
  });

  it("floors the year at 1950 and accepts an absent one", () => {
    expect(() => parse({ certificates: [certificate({ year: 1949 })] })).toThrow();
    expect(() => parse({ certificates: [certificate({ year: 1950 })] })).not.toThrow();
    expect(() => parse({ certificates: [certificate({ year: null })] })).not.toThrow();
  });

  it("refuses a year in the FUTURE, which the old fixed 2100 ceiling did not (#1407)", () => {
    // THE CASE THE OLD BOUND MISSED, and the reason this test is written against the clock
    // rather than against a literal. `.max(2100)` rejected 2101 and accepted 2099, so the
    // schema's own doc comment — "a year in the future ... is a typo" — described a rule it
    // did not implement, and would not have implemented at any point in this platform's life.
    const thisYear = new Date().getFullYear();
    expect(() => parse({ certificates: [certificate({ year: thisYear })] })).not.toThrow();
    expect(() => parse({ certificates: [certificate({ year: thisYear + 1 })] })).toThrow();
    // 2099 is the concrete row a worker could have submitted before this fix. Kept as a literal
    // as well as the relative case, because it is the claim the issue was filed about — and it
    // stays a future year for the next seventy-odd years, so it will not rot into a false pass.
    expect(() => parse({ certificates: [certificate({ year: 2099 })] })).toThrow();
  });

  it("refuses a blank certificate name — a nameless row prints its issuer and nothing else", () => {
    expect(() => parse({ certificates: [certificate({ name: "   " })] })).toThrow();
  });

  it("rejects unknown keys, so a client cannot smuggle a field past validation", () => {
    expect(() => parse({ certificates: [{ ...certificate(), grade: "A" }] })).toThrow();
    expect(() => parse({ certificates: [certificate()], notes: "hi" })).toThrow();
  });
});
