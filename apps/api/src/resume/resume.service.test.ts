import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Queue } from "bullmq";
import { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";
import type { ResumeRateLimit } from "./resume-rate-limit.service";
import type { ProfilesRepository } from "../profiles/profiles.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { AiService } from "../ai/ai.service";
import type { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { StorageService } from "../storage/storage.service";
import type { ResumeRenderJobData } from "../queue/queue.constants";
import type { RequestContext } from "../common/request-context";
import type { GenerateResumeInput } from "./resume.dto";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const DTO: GenerateResumeInput = { worker_id: "w-1", profile_id: "p-1" };
const NAME = "Asha Kumari";

// Per-svc events handle, so a test can read the emit calls for that instance.
const EVENTS = new WeakMap<ResumeService, { emit: ReturnType<typeof vi.fn> }>();
function lastEvents(svc: ResumeService): { emit: ReturnType<typeof vi.fn> } {
  const e = EVENTS.get(svc);
  if (!e) throw new Error("no events handle for svc");
  return e;
}

function setup(
  fullNameToken: string | null,
  opts: { previousVersion?: number; previousProfileId?: string } = {},
) {
  const profiles = {
    // Default: a CONFIRMED profile owned by w-1 (the happy path). Ownership /
    // confirmed-gate tests override this per-call.
    findById: vi.fn(
      async () =>
        ({ id: "p-1", workerId: "w-1", profileStatus: "confirmed", rawProfile: {} }) as
          | Record<string, unknown>
          | undefined,
    ),
  };
  // The AI mock returns a NAME-LESS resume (as the real service does).
  const ai = {
    generateResume: vi.fn(
      async (
        _input: unknown,
      ): Promise<{
        resume_text: string;
        resume_json: Record<string, unknown>;
        format: string;
        is_mock: boolean;
        // #745 — part of the contract now; a mock run reports no spend.
        ai_metadata: Record<string, unknown> | null;
      }> => ({
        resume_text: "PROFESSIONAL SUMMARY (draft)",
        resume_json: { profile: {} },
        format: "text",
        is_mock: true,
        ai_metadata: null,
      }),
    ),
  };
  const workers = {
    findById: vi.fn(async () => ({ id: "w-1", fullName: fullNameToken })),
    // Return type WIDENED to the row shape (same trick as `profiles.findById` above), so a
    // test can re-stub this with the render columns myDocument reads. The default keeps the
    // three fields `generate` uses to pick the next version.
    latestResume: vi.fn(
      async (): Promise<Record<string, unknown> | undefined> =>
        opts.previousVersion != null
          ? { id: "prev", version: opts.previousVersion, profileId: opts.previousProfileId }
          : undefined,
    ),
  };
  const pii = { decrypt: vi.fn(() => NAME) };
  const resumes = {
    // create() is the regenerate (force) path → version comes from the input.
    create: vi.fn(async (input: Record<string, unknown>) => ({ id: "res-1", ...input })),
    // createInitial() is the idempotent initial path (version 1). The optional
    // `existing` lets a test simulate a row already present (conflict) for the
    // insert-if-absent (systemInitiated) case.
    createInitial: vi.fn(async (input: Record<string, unknown>, _o: { overwrite: boolean }) => ({
      id: "res-1",
      ...input,
    })),
    // findById backs getById/download/regenerate/recordShare; tests override it.
    findById: vi.fn(async (_id: string) => undefined as Record<string, unknown> | undefined),
    // #1399 — enqueueRender marks the row failed when the queue add throws. Without these on the
    // fake, that call raised a TypeError that the method's own inner catch swallowed, so the
    // enqueue-failure test passed while asserting nothing about the row.
    //
    // BOTH are stubbed on purpose: the service must use the status-GUARDED one, and the
    // unguarded sibling is here only so a test can assert it is never reached.
    markRenderFailedIfPending: vi.fn(async (_id: string) => undefined),
    markRenderFailed: vi.fn(async (_id: string) => undefined),
  };
  const events = {
    emit: vi.fn(async (params: { event_name: string; payload: Record<string, unknown> }) => params),
  };
  // Rate-cap is a pass-through here (its own behaviour is covered separately).
  const rateLimit = { assertWithinDailyCap: vi.fn(async (_workerId: string) => undefined) };
  // The render enqueue must never affect generation; record the call only.
  const renderQueue = {
    add: vi.fn(async (_name: string, _data: Record<string, unknown>) => undefined),
  };
  const storage = {
    createSignedUrl: vi.fn(
      async (_key: string, _ttl: number) => "https://signed.example/url?token=abc",
    ),
  };
  const config = {
    RESUME_SIGNED_URL_TTL_SECONDS: 900,
    RESUME_RATE_LIMIT_PER_IP_PER_HOUR: 20,
  } as ServerConfig;

  // #745: the résumé cost emitter. Stubbed (not the real recorder) so a test asserts on
  // the RECORD CALL rather than on an event round-trip through EventsService.
  const aiCost = {
    record: vi.fn(
      async (
        _meta: unknown,
        _taskType: string,
        _aiJobId: string | null,
        _correlationId: string,
        _requestId: string,
      ) => {},
    ),
  };

  // 0083: the SHARED trace fake — a résumé call HAS a worker, so `traces.stored` is where
  // the prompt/response pair actually lands.
  const traces = fakeAiTraceRecorder();

  const svc = new ResumeService(
    resumes as unknown as ResumeRepository,
    profiles as unknown as ProfilesRepository,
    workers as unknown as WorkersRepository,
    // No trade pack in these fixtures, so every resume here keeps `classic` — which is exactly
    // the byte-identical path the template gating has to preserve for a worker whose trade has
    // no sheet authored yet.
    { loadTradeSheet: async () => ({ packId: null, attributes: [] }) } as never,
    events as unknown as EventsService,
    ai as unknown as AiService,
    aiCost as unknown as AiCostRecorder,
    traces.recorder,
    pii as unknown as PiiCryptoService,
    rateLimit as unknown as ResumeRateLimit,
    storage as unknown as StorageService,
    config,
    renderQueue as unknown as Queue<ResumeRenderJobData>,
  );
  EVENTS.set(svc, events);
  return {
    svc,
    ai,
    aiCost,
    traces,
    pii,
    profiles,
    resumes,
    rateLimit,
    renderQueue,
    events,
    storage,
    config,
    // Exposed so the myDocument suite can re-stub `latestResume` per case — that read is the
    // whole of GET /resume/document, and the harness could not reach it before (#1397).
    workers,
  };
}

/**
 * #745 — résumé spend reaches the ledger.
 *
 * `router.run` on the ai-service had always built this metadata; `/resume/generate` simply
 * dropped it, so the contract carried no cost field and no emitter could exist. The failure
 * was silent by construction: no exception, just an empty
 * `SELECT ... WHERE task_type = 'resume_generation'` that reads as "no spend".
 */
describe("ResumeService — resume_generation cost is recorded (#745)", () => {
  const META = {
    ai_call_id: "11111111-1111-4111-8111-111111111111",
    model_name: "gemini-2.5-flash",
    real_call: true,
    estimated_cost_inr: 0.42,
  };

  it("records the metadata the AI service returned, against a null ai_job id", async () => {
    const { svc, ai, aiCost } = setup("v1.ciphertext");
    ai.generateResume.mockResolvedValue({
      resume_text: "RESUME",
      resume_json: { profile: {} },
      format: "text",
      is_mock: false,
      ai_metadata: META,
    });

    await svc.generate(DTO, CTX);

    expect(aiCost.record).toHaveBeenCalledOnce();
    const [meta, taskType, aiJobId] = aiCost.record.mock.calls[0]!;
    expect(meta).toEqual(META);
    expect(taskType).toBe("resume_generation");
    // Résumé generation runs inline (and its BullMQ path is a queue job, not an ai_jobs
    // row), so there is no job id to attribute to and null is the honest value.
    expect(aiJobId).toBeNull();
  });

  it("passes null through when nothing was spent — no fabricated ₹0 record", async () => {
    // The pseudonymize-blocked and service-unreachable paths both return null metadata.
    // `record` no-ops on null, so the ledger stays silent rather than logging a call that
    // never reached a provider.
    const { svc, ai, aiCost } = setup("v1.ciphertext");
    ai.generateResume.mockResolvedValue({
      resume_text: "LOCAL DRAFT",
      resume_json: { profile: {} },
      format: "text",
      is_mock: true,
      ai_metadata: null,
    });

    await svc.generate(DTO, CTX);

    expect(aiCost.record).toHaveBeenCalledOnce();
    expect(aiCost.record.mock.calls[0]![0]).toBeNull();
  });

  it("records BEFORE the row is written, so a failed write cannot lose the spend", async () => {
    // The ordering #738 chose for STT: the rupees are already gone by the time the AI call
    // returns, so the record must not be downstream of anything that can throw.
    const { svc, ai, aiCost, resumes } = setup("v1.ciphertext");
    ai.generateResume.mockResolvedValue({
      resume_text: "RESUME",
      resume_json: { profile: {} },
      format: "text",
      is_mock: false,
      ai_metadata: META,
    });
    resumes.createInitial.mockRejectedValue(new Error("db down"));

    await expect(svc.generate(DTO, CTX)).rejects.toThrow("db down");
    expect(aiCost.record).toHaveBeenCalledOnce();
    expect(aiCost.record.mock.calls[0]![0]).toEqual(META);
  });
});

describe("ResumeService — TD21 name injection", () => {
  it("injects the decrypted name into the resume but NEVER sends it to the AI service", async () => {
    const { svc, ai, pii, resumes } = setup("v1.ciphertext");
    await svc.generate(DTO, CTX);

    // The AI service only ever received the structured profile — no name anywhere.
    const aiArg = ai.generateResume.mock.calls[0]![0];
    expect(JSON.stringify(aiArg)).not.toMatch(/Asha/i);

    expect(pii.decrypt).toHaveBeenCalledWith("v1.ciphertext");
    const saved = resumes.createInitial.mock.calls[0]![0] as {
      resumeText: string;
      resumeJson: { name?: string };
    };
    expect(saved.resumeText).toContain(NAME); // name lands on the worker's own resume
    expect(saved.resumeJson.name).toBe(NAME);
  });

  it("omits the name when none is set — no decrypt, resume unchanged", async () => {
    const { svc, pii, resumes } = setup(null);
    await svc.generate(DTO, CTX);

    expect(pii.decrypt).not.toHaveBeenCalled();
    const saved = resumes.createInitial.mock.calls[0]![0] as {
      resumeText: string;
      resumeJson: { name?: string };
    };
    expect(saved.resumeText).toBe("PROFESSIONAL SUMMARY (draft)");
    expect(saved.resumeJson.name).toBeUndefined();
  });

  it("degrades to a name-less resume when full_name can't be decrypted (no 500)", async () => {
    // A malformed/rotated/tampered token must not break resume generation.
    const { svc, pii, resumes } = setup("v1.corrupt-token");
    pii.decrypt.mockImplementation(() => {
      throw new Error("GCM auth failed");
    });

    const out = await svc.generate(DTO, CTX); // must NOT throw
    expect(out.resume_id).toBeTruthy();
    const saved = resumes.createInitial.mock.calls[0]![0] as {
      resumeText: string;
      resumeJson: { name?: string };
    };
    expect(saved.resumeText).toBe("PROFESSIONAL SUMMARY (draft)"); // name-less fallback
    expect(saved.resumeJson.name).toBeUndefined();
  });
});

describe("ResumeService — ownership + confirmed gate (TD70 item 5)", () => {
  it("404s (no existence oracle) when the profile does not exist — AI never called, no event", async () => {
    const { svc, ai, profiles } = setup(null);
    profiles.findById.mockResolvedValueOnce(undefined);
    await expect(svc.generate(DTO, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(ai.generateResume).not.toHaveBeenCalled();
    expect(lastEvents(svc).emit).not.toHaveBeenCalled();
  });

  it("404s (no existence oracle) when the caller does not OWN the profile — indistinguishable from not-found", async () => {
    // worker_id is session-derived in the controller, so this IS the authz gate.
    const { svc, ai } = setup(null);
    await expect(
      svc.generate({ worker_id: "w-other", profile_id: "p-1" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ai.generateResume).not.toHaveBeenCalled();
    expect(lastEvents(svc).emit).not.toHaveBeenCalled();
  });

  it("400s ('profile is not confirmed') on a manual generate for an UNCONFIRMED profile — AI never called", async () => {
    const { svc, ai, profiles } = setup(null);
    profiles.findById.mockResolvedValueOnce({
      id: "p-1",
      workerId: "w-1",
      profileStatus: "extracted",
      rawProfile: {},
    });
    await expect(svc.generate(DTO, CTX)).rejects.toBeInstanceOf(BadRequestException);
    expect(ai.generateResume).not.toHaveBeenCalled();
    expect(lastEvents(svc).emit).not.toHaveBeenCalled();
  });

  it("systemInitiated SKIPS the confirmed re-read (enqueued ON profile.confirmed by definition)", async () => {
    // The auto-generate must keep working even if the status write and the queued
    // job race — the enqueue only ever happens post-confirm.
    const { svc, profiles } = setup(null);
    profiles.findById.mockResolvedValueOnce({
      id: "p-1",
      workerId: "w-1",
      profileStatus: "extracted",
      rawProfile: {},
    });
    const out = await svc.generate(DTO, CTX, { systemInitiated: true });
    expect(out.resume_id).toBe("res-1");
  });

  it("confirmed + owned generates normally (201 happy path unchanged)", async () => {
    const { svc } = setup(null);
    const out = await svc.generate(DTO, CTX);
    expect(out.resume_id).toBe("res-1");
    expect(out.version).toBe(1);
  });
});

describe("ResumeService — TD5 rate-limit, events, and render enqueue", () => {
  it("asserts the daily cap FIRST — before any AI / profile / render work", async () => {
    const { svc, rateLimit } = setup(null);
    // Make the cap reject; nothing downstream should run.
    const order: string[] = [];
    rateLimit.assertWithinDailyCap.mockImplementation(async () => {
      order.push("ratelimit");
      throw new HttpException("cap", HttpStatus.TOO_MANY_REQUESTS);
    });

    await expect(svc.generate(DTO, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(order).toEqual(["ratelimit"]);
  });

  it("does not call the AI service when the rate-limit rejects", async () => {
    const { svc, ai, rateLimit } = setup(null);
    rateLimit.assertWithinDailyCap.mockRejectedValue(
      new HttpException("cap", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(svc.generate(DTO, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(ai.generateResume).not.toHaveBeenCalled();
  });

  it("emits resume.generated on a first-ever resume (v1)", async () => {
    const { svc } = setup(null);
    const events = lastEvents(svc);
    await svc.generate(DTO, CTX);
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("resume.generated");
    expect(call.payload.version).toBe(1);
    expect(call.payload).not.toHaveProperty("previous_version");
  });

  it("emits resume.regenerated with previous_version on an explicit regenerate (version > 1)", async () => {
    const { svc } = setup(null, { previousVersion: 2 });
    const events = lastEvents(svc);
    await svc.generate(DTO, CTX, { forceNewVersion: true });
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("resume.regenerated");
    expect(call.payload.version).toBe(3);
    expect(call.payload.previous_version).toBe(2);
  });

  it("enqueues a render job carrying refs + tracing only (no PII)", async () => {
    const { svc, renderQueue } = setup("v1.ciphertext");
    await svc.generate(DTO, CTX);
    expect(renderQueue.add).toHaveBeenCalledOnce();
    const [, payload] = renderQueue.add.mock.calls[0]!;
    expect(payload).toEqual({
      resumeId: "res-1",
      workerId: "w-1",
      correlationId: "c",
      requestId: "r",
    });
    // The decrypted name must never ride the render job.
    expect(JSON.stringify(payload)).not.toMatch(/Asha/i);
  });

  it("a render-enqueue failure does NOT fail generation (caught + degraded)", async () => {
    const { svc, renderQueue } = setup(null);
    renderQueue.add.mockRejectedValue(new Error("redis down"));
    const out = await svc.generate(DTO, CTX); // must NOT throw
    expect(out.resume_id).toBe("res-1");
  });

  /**
   * #1399 — the enqueue swallow was the SECOND way a row parked at 'pending' forever, and the
   * one with no job behind it at all. `add` throwing meant nothing was ever scheduled, so the
   * row's 'pending' was not a state but a permanent misreport: `GET /resume/document` polls it
   * and `download` 409s "please retry shortly" for a render that was never queued.
   */
  it("a render-enqueue failure marks the row FAILED — 'pending' with no job is a lie", async () => {
    const { svc, renderQueue, resumes } = setup(null);
    renderQueue.add.mockRejectedValue(new Error("redis down"));
    await svc.generate(DTO, CTX);
    expect(resumes.markRenderFailedIfPending).toHaveBeenCalledWith("res-1");
  });

  it("uses the status-GUARDED write, never the unconditional one — TD77 degrade-open", async () => {
    // `saved` is not always the row we just inserted: on the system auto-generate path
    // `createInitial({overwrite:false})` returns the PRE-EXISTING row from its conflict branch,
    // which may already be 'rendered' with a live PDF. The unguarded `markRenderFailed` would
    // 409 that resume permanently, with no job left to repair it — this endpoint never reaches
    // the processor's `wasRendered` guards, so the predicate has to be in the UPDATE.
    const { svc, renderQueue, resumes } = setup(null);
    renderQueue.add.mockRejectedValue(new Error("redis down"));
    await svc.generate(DTO, CTX);
    expect(resumes.markRenderFailed).not.toHaveBeenCalled();
  });

  it("generation still succeeds when BOTH the enqueue AND the failed-marking throw", async () => {
    // Redis down does not imply Postgres is, but if both are, the worker must still get the
    // resume text they already paid for rather than a 500 from the bookkeeping about it.
    const { svc, renderQueue, resumes } = setup(null);
    renderQueue.add.mockRejectedValue(new Error("redis down"));
    resumes.markRenderFailedIfPending.mockRejectedValue(new Error("pg down"));
    const out = await svc.generate(DTO, CTX);
    expect(out.resume_id).toBe("res-1");
  });
});

describe("ResumeService — idempotent initial resume (TD5)", () => {
  it("manual generate is authoritative: createInitial with overwrite=true (refresh content)", async () => {
    // The name is recorded after the (name-less) auto-generate; the manual generate
    // must overwrite the existing v1 with the named content — never create a v2.
    const { svc, resumes } = setup("v1.ciphertext");
    const out = await svc.generate(DTO, CTX); // not systemInitiated
    expect(resumes.createInitial).toHaveBeenCalledOnce();
    expect(resumes.create).not.toHaveBeenCalled();
    const [input, options] = resumes.createInitial.mock.calls[0]!;
    expect((options as { overwrite: boolean }).overwrite).toBe(true);
    expect((input as { version: number }).version).toBe(1);
    expect((input as { resumeJson: { name?: string } }).resumeJson.name).toBe(NAME);
    expect(out.version).toBe(1);
  });

  it("system auto-generate inserts-if-absent: createInitial with overwrite=false", async () => {
    const { svc, resumes } = setup(null);
    await svc.generate(DTO, CTX, { systemInitiated: true });
    expect(resumes.createInitial).toHaveBeenCalledOnce();
    const [, options] = resumes.createInitial.mock.calls[0]!;
    expect((options as { overwrite: boolean }).overwrite).toBe(false);
  });

  it("forceNewVersion creates a new version via create() (not the initial path)", async () => {
    const { svc, resumes } = setup(null, { previousVersion: 1 });
    const out = await svc.generate(DTO, CTX, { forceNewVersion: true });
    expect(resumes.create).toHaveBeenCalledOnce();
    expect(resumes.createInitial).not.toHaveBeenCalled();
    expect(out.version).toBe(2);
  });
});

const RES_ID = "11111111-1111-1111-1111-111111111111";
// Align with the generate-path mocks in setup(): profile/worker are "w-1"/"p-1".
const OWNER = "w-1";
const OTHER = "99999999-9999-9999-9999-999999999999";
const ROW = {
  id: RES_ID,
  workerId: OWNER,
  profileId: "p-1",
  resumeJson: { summary: "CNC/VMC operator" },
  resumeText: "Experienced CNC/VMC operator.",
  generatedAt: new Date("2026-06-11T00:00:00.000Z"),
  version: 2,
  renderStatus: "pending" as string,
  pdfStorageKey: null as string | null,
};

/**
 * #1397 — GET /resume/document had NO coverage at all, which is how it shipped a `document`
 * whose two nulls ("not rendered yet" and "nothing to render, ever") were indistinguishable.
 *
 * These cases are written against the STATES THE ROW CAN ACTUALLY REACH, not against the happy
 * path plus a 404. Each one names the writer that produces it, because the value of the two new
 * fields is exactly that they tell those states apart.
 */
describe("ResumeService.myDocument (#1397 — the render signals a client polls on)", () => {
  const RENDERED_AT = new Date("2026-09-03T10:15:30.000Z");
  const DOC = { header: { name: "Asha K." }, sections: [] };

  /** A generated_resumes row as `latestResume` returns it — overrides applied on top. */
  function row(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "r-1",
      version: 1,
      resumeDocument: null,
      renderStatus: "pending",
      renderedAt: null,
      // Present on the real row and deliberately NOT projected — see the exposure case below.
      pdfStorageKey: "resumes/w-1/r-1/v1.pdf",
      resumeText: "PROFESSIONAL SUMMARY (draft)",
      ...over,
    };
  }

  it("404s when the worker has no resume row at all", async () => {
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(undefined);
    await expect(svc.myDocument("w-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads the LATEST row for the SESSION worker — no id is taken from the request", async () => {
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(row());
    await svc.myDocument("w-42");
    expect(workers.latestResume).toHaveBeenCalledWith("w-42");
  });

  it("first render in flight: pending, no document, no rendered_at — 'ask again shortly'", async () => {
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(row());
    await expect(svc.myDocument("w-1")).resolves.toEqual({
      resume_id: "r-1",
      version: 1,
      document: null,
      render_status: "pending",
      rendered_at: null,
    });
  });

  it("rendered: the document and the timestamp written by the SAME update both surface", async () => {
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "rendered", resumeDocument: DOC, renderedAt: RENDERED_AT, version: 2 }),
    );
    await expect(svc.myDocument("w-1")).resolves.toEqual({
      resume_id: "r-1",
      version: 2,
      document: DOC,
      render_status: "rendered",
      rendered_at: "2026-09-03T10:15:30.000Z",
    });
  });

  it("LEGACY row (rendered before migration 0095): rendered + document null — stop polling THIS render", async () => {
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "rendered", resumeDocument: null, renderedAt: RENDERED_AT }),
    );
    const res = await svc.myDocument("w-1");
    // The combination is the whole point: a client that waits on this burns its retry budget
    // for a document THIS render will never produce, which is the behaviour #1396 shipped as a
    // stopgap. (A later forced re-render does fill the column, so the answer is "re-read next
    // time", not "cache the negative".)
    expect(res.render_status).toBe("rendered");
    expect(res.document).toBeNull();
    expect(res.rendered_at).toBe("2026-09-03T10:15:30.000Z");
  });

  it("STALE-under-pending: a manual regenerate resets the status and rendered_at but leaves the old document", async () => {
    // `ResumeRepository.createInitial({overwrite:true})` sets renderStatus 'pending',
    // pdfStorageKey null and renderedAt null — and omits resumeDocument from the SET list, so
    // the previous render's document survives. rendered_at:null is what marks it stale.
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "pending", resumeDocument: DOC, renderedAt: null }),
    );
    const res = await svc.myDocument("w-1");
    expect(res).toMatchObject({ render_status: "pending", document: DOC, rendered_at: null });
  });

  it("failed rows may still HOLD a renderable document — 'failed' is terminal for the PDF, not for the document", async () => {
    // The fail-closed photo-removal path (`markRenderFailed`) writes only render_status, to
    // take PDF bytes carrying an erased face out of service. The document carries no photo.
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "failed", resumeDocument: DOC, renderedAt: RENDERED_AT }),
    );
    const res = await svc.myDocument("w-1");
    expect(res.render_status).toBe("failed");
    expect(res.document).toEqual(DOC);
  });

  it("FORCED RE-RENDER: render_status never leaves 'rendered', so ONLY rendered_at can signal the new document", async () => {
    // THE CASE THAT DECIDED THE SHAPE OF THIS RESPONSE. A description-source change enqueues a
    // forced re-render over an already-'rendered' row and nothing ever writes 'pending', so a
    // client polling render_status alone stops on the FIRST read, holding the OLD document.
    const { svc, workers } = setup(null);
    const before = new Date("2026-09-03T10:00:00.000Z");
    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "rendered", resumeDocument: { v: "old" }, renderedAt: before }),
    );
    const first = await svc.myDocument("w-1");

    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "rendered", resumeDocument: { v: "new" }, renderedAt: RENDERED_AT }),
    );
    const second = await svc.myDocument("w-1");

    expect(first.render_status).toBe(second.render_status); // 'rendered' throughout — no signal
    expect(second.rendered_at).not.toBe(first.rendered_at); // the only thing that moved
    expect(second.document).toEqual({ v: "new" });
  });

  it("rendered_at reaches the wire as an ISO-8601 STRING, not a Date", async () => {
    // The declared contract says `string | null`; serializing in the service rather than
    // leaving a Date for the JSON layer is what makes that true, and makes the client's
    // "has it changed since my write?" a plain string comparison.
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(row({ renderedAt: RENDERED_AT }));
    const res = await svc.myDocument("w-1");
    expect(typeof res.rendered_at).toBe("string");
    expect(res.rendered_at).toBe(RENDERED_AT.toISOString());
  });

  it("projects five fields and NOTHING else — no storage key, no resume_text, no raw row", async () => {
    const { svc, workers } = setup(null);
    workers.latestResume.mockResolvedValue(
      row({ renderStatus: "rendered", resumeDocument: DOC, renderedAt: RENDERED_AT }),
    );
    const res = await svc.myDocument("w-1");
    expect(Object.keys(res).sort()).toEqual([
      "document",
      "render_status",
      "rendered_at",
      "resume_id",
      "version",
    ]);
    // `pdf_storage_key` is a private-bucket object key; it must never ride a worker response.
    expect(JSON.stringify(res)).not.toContain("resumes/w-1/r-1/v1.pdf");
  });
});

describe("ResumeService.getById (ops read view)", () => {
  it("returns the resume shaped snake_case and PII-free", async () => {
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce(ROW);
    const res = await svc.getById(RES_ID);
    expect(res).toEqual({
      resume_id: RES_ID,
      worker_id: OWNER,
      profile_id: ROW.profileId,
      version: 2,
      resume_text: ROW.resumeText,
      resume_json: ROW.resumeJson,
      render_status: "pending",
      generated_at: ROW.generatedAt,
    });
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  it("404s when the resume does not exist", async () => {
    const { svc } = setup(null);
    await expect(svc.getById(RES_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ResumeService.download (TD5 / TD29 worker-authed + ownership)", () => {
  it("mints a signed URL + emits resume.downloaded (actor=worker) for the OWNER of a rendered PDF", async () => {
    const { svc, resumes, storage, events } = setup(null);
    resumes.findById.mockResolvedValueOnce({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: "resumes/w/r/v2.pdf",
    });
    const res = await svc.download(OWNER, RES_ID, CTX);
    expect(res).toEqual({ url: "https://signed.example/url?token=abc", expires_in: 900 });
    expect(storage.createSignedUrl).toHaveBeenCalledWith("resumes/w/r/v2.pdf", 900);
    const call = events.emit.mock.calls[0]![0] as {
      event_name: string;
      actor: { actor_type: string; actor_id: string };
      payload: Record<string, unknown>;
    };
    expect(call.event_name).toBe("resume.downloaded");
    expect(call.payload.format).toBe("pdf");
    expect(call.actor).toEqual({ actor_type: "worker", actor_id: OWNER });
    expect(call.payload.worker_id).toBe(OWNER);
    // The signed URL (token) must NEVER ride the event payload.
    expect(JSON.stringify(call.payload)).not.toContain("token=abc");
  });

  it("404s for a NON-OWNER (no existence oracle) and mints/emits nothing", async () => {
    const { svc, resumes, storage, events } = setup(null);
    resumes.findById.mockResolvedValueOnce({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: "resumes/w/r/v2.pdf",
    });
    await expect(svc.download(OTHER, RES_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("409s while still rendering ('pending') and emits nothing", async () => {
    const { svc, resumes, storage, events } = setup(null);
    resumes.findById.mockResolvedValueOnce({ ...ROW, renderStatus: "pending" });
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("409s when the render failed", async () => {
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce({ ...ROW, renderStatus: "failed" });
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it("409s when rendered but the storage key is missing (defensive)", async () => {
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: null,
    });
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s when the resume does not exist", async () => {
    const { svc } = setup(null);
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ResumeService.recordShare (TD5)", () => {
  it("emits resume.shared with the closed-enum channel and no free text", async () => {
    const { svc, resumes, events } = setup(null);
    resumes.findById.mockResolvedValueOnce(ROW);
    const res = await svc.recordShare(OWNER, RES_ID, { channel: "whatsapp" }, CTX);
    expect(res).toEqual({ ok: true });
    const call = events.emit.mock.calls[0]![0] as {
      event_name: string;
      payload: { channel: string };
    };
    expect(call.event_name).toBe("resume.shared");
    expect(call.payload.channel).toBe("whatsapp");
  });

  it("404s when the resume does not exist", async () => {
    const { svc } = setup(null);
    await expect(svc.recordShare(OWNER, RES_ID, { channel: "link" }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("R16 §5.1 — 404s when the resume belongs to ANOTHER worker, and emits nothing", async () => {
    // THE FORGERY THIS CLOSES. `recordShare` took only a resume id and read the actor and the
    // payload's `worker_id` off whatever row it found — harmless while the route required an
    // internal-service secret, and a rankable forgery the moment it took a worker session:
    // a guessed UUID would have written an engagement signal in a stranger's name, and worker
    // engagement is a first-class ranking signal.
    const { svc, resumes, events } = setup(null);
    resumes.findById.mockResolvedValueOnce(ROW);
    await expect(
      svc.recordShare("11111111-1111-4111-8111-111111111111", RES_ID, { channel: "link" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("R16 §5.1 — a stranger's resume and a missing one are INDISTINGUISHABLE", async () => {
    // No existence oracle over other workers' resume ids: both answer 404 with the same message,
    // exactly as `download` does.
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce(ROW);
    const notOwner = await svc
      .recordShare("11111111-1111-4111-8111-111111111111", RES_ID, { channel: "link" }, CTX)
      .catch((e: Error) => e.message);
    const missing = await svc
      .recordShare(OWNER, RES_ID, { channel: "link" }, CTX)
      .catch((e: Error) => e.message);
    expect(notOwner).toBe(missing);
  });
});

describe("ResumeService.regenerate (TD5)", () => {
  it("loads the source resume then calls generate (forcing a new version)", async () => {
    const { svc, resumes } = setup(null, { previousVersion: 2, previousProfileId: ROW.profileId });
    resumes.findById.mockResolvedValueOnce(ROW);
    const out = await svc.regenerate(RES_ID, CTX);
    // generate() ran the force path (create, not createInitial) → version bumped.
    expect(resumes.create).toHaveBeenCalledOnce();
    expect(out.version).toBe(3);
  });

  it("404s when the source resume does not exist", async () => {
    const { svc, resumes } = setup(null);
    await expect(svc.regenerate(RES_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(resumes.create).not.toHaveBeenCalled();
  });
});
