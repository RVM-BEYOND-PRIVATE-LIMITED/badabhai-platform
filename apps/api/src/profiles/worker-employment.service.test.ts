import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../common/request-context";
import { SetMyEmploymentSchema } from "./worker-employment.dto";
import { WorkerEmploymentService } from "./worker-employment.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;

const EMPLOYER = "Sandhar Technologies Limited, Plant II";

function setup() {
  // Typed explicitly. `vi.fn(async () => ...)` infers a ZERO-ARG signature, so `mock.calls[0][1]`
  // is a type error even though the call happens at runtime - the tests passed and tsc did not.
  type Row = {
    employerNameEnc: string;
    employerCity: string | null;
    durationStated: boolean;
    role: { roleLabel: string; startYm: string | null };
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
  const svc = new WorkerEmploymentService(
    { replaceForWorker } as never,
    { findById: async () => ({ id: WORKER }), latestResume: async () => null } as never,
    { encrypt } as never,
    { emit } as never,
    { add } as never,
  );
  return { svc, replaceForWorker, emit, add, encrypt };
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

  it("gives the single role the employment's own dates (v1: one role each)", async () => {
    await h.svc.replaceForWorker(WORKER, parse([entry()]), CTX);
    const written = h.replaceForWorker.mock.calls[0]![1];
    expect(written[0]!.role).toMatchObject({ roleLabel: "CNC Turner", startYm: "2022-04" });
  });

  it("accepts an EMPTY list as a real edit that clears the block", async () => {
    const result = await h.svc.replaceForWorker(WORKER, parse([]), CTX);
    expect(result.employer_count).toBe(0);
    expect(h.replaceForWorker).toHaveBeenCalledWith(WORKER, []);
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
