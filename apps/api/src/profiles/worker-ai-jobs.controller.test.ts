import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { AiJob } from "@badabhai/db";
import { WorkerAiJobsController } from "./worker-ai-jobs.controller";
import type { AiJobsRepository } from "./ai-jobs.repository";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";

/**
 * The worker-facing AI-job poll. Two things must hold and both are security
 * properties, not conveniences:
 *
 *  1. the repository is asked for the job SCOPED TO THE CALLER (the worker id comes
 *     from the token, never a param), and
 *  2. the response carries exactly three keys — no cost, no model, no `real_call`,
 *     no `error_message`, no timestamps.
 *
 * The ownership predicate itself is proven in ai-jobs.repository.test.ts (evaluated,
 * not string-matched); here we prove the controller actually CALLS it with the token
 * worker and does not widen the projection.
 */

const JOB = "99999999-9999-4999-8999-999999999999";
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sess-1" };
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A full ai_jobs row, including every field that must NOT reach the worker. */
const row = (patch: Partial<AiJob> = {}): AiJob =>
  ({
    id: JOB,
    jobType: "profile_extraction",
    status: "completed",
    inputRef: { worker_id: WORKER.id, session_id: "s1" },
    outputRef: { profile_id: "p1" },
    errorMessage: null,
    modelName: "gemini-2.0-flash",
    realCall: true,
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    costInr: 0.0137,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:09.000Z"),
    ...patch,
  }) as AiJob;

function makeController(job: AiJob | undefined) {
  const findByIdForWorker = vi.fn().mockResolvedValue(job);
  const repo = { findByIdForWorker } as unknown as AiJobsRepository;
  return { controller: new WorkerAiJobsController(repo), findByIdForWorker };
}

describe("WorkerAiJobsController.get — scoping", () => {
  it("asks for the job scoped to the TOKEN worker, not any caller-supplied id", async () => {
    const { controller, findByIdForWorker } = makeController(row());
    await controller.get(WORKER, JOB);
    expect(findByIdForWorker).toHaveBeenCalledWith(JOB, WORKER.id);
  });

  it("never calls an unscoped lookup", async () => {
    const findById = vi.fn();
    const findByIdForWorker = vi.fn().mockResolvedValue(row());
    const repo = { findById, findByIdForWorker } as unknown as AiJobsRepository;
    await new WorkerAiJobsController(repo).get(WORKER, JOB);
    // findById would return ANY worker's job — using it here would be the IDOR.
    expect(findById).not.toHaveBeenCalled();
  });

  it("404s when the repository returns nothing", async () => {
    const { controller } = makeController(undefined);
    await expect(controller.get(WORKER, JOB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("gives the SAME answer for not-found and not-yours (no enumeration oracle)", async () => {
    // The repository returns undefined in both cases by construction — the
    // ownership leg is part of the WHERE. Assert the controller does not
    // distinguish them in status or message.
    const thrown = async (worker: AuthenticatedWorker): Promise<unknown> => {
      try {
        await makeController(undefined).controller.get(worker, JOB);
        throw new Error("expected the controller to throw");
      } catch (err) {
        return err;
      }
    };

    const a = await thrown(WORKER);
    const b = await thrown({ ...WORKER, id: OTHER });
    expect(a).toBeInstanceOf(NotFoundException);
    expect(b).toBeInstanceOf(NotFoundException);
    // Same status AND same message — either differing would be the oracle.
    expect((a as NotFoundException).getStatus()).toBe((b as NotFoundException).getStatus());
    expect((a as NotFoundException).message).toBe((b as NotFoundException).message);
  });
});

describe("WorkerAiJobsController.get — projection", () => {
  it("returns exactly status + profile_id + voice_note_id", async () => {
    const { controller } = makeController(row());
    const res = await controller.get(WORKER, JOB);
    expect(Object.keys(res).sort()).toEqual(["profile_id", "status", "voice_note_id"]);
    expect(res).toEqual({ status: "completed", profile_id: "p1", voice_note_id: null });
  });

  it("withholds every operational and cost field the ops route returns", async () => {
    const { controller } = makeController(row());
    const serialized = JSON.stringify(await controller.get(WORKER, JOB));
    for (const leaked of [
      "gemini", // model_name — vendor/model fingerprint
      "real_call",
      "cost_inr",
      "0.0137",
      "1540", // token counts
      "error_message",
      "created_at",
      "updated_at",
      "job_type",
      "input_ref", // would carry worker_id + session_id
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("never echoes the job id (the client already holds it)", async () => {
    const { controller } = makeController(row());
    expect(JSON.stringify(await controller.get(WORKER, JOB))).not.toContain(JOB);
  });

  it("carries no PII", async () => {
    const { controller } = makeController(
      row({ inputRef: { worker_id: WORKER.id, session_id: "s1" } }),
    );
    const serialized = JSON.stringify(await controller.get(WORKER, JOB));
    expect(serialized).not.toMatch(/phone|full_?name/i);
    expect(serialized).not.toContain(WORKER.id);
  });

  it("flattens a transcription job's voice_note_id", async () => {
    const { controller } = makeController(
      row({ jobType: "transcription", outputRef: { voice_note_id: "v1" } }),
    );
    expect(await controller.get(WORKER, JOB)).toEqual({
      status: "completed",
      profile_id: null,
      voice_note_id: "v1",
    });
  });

  it("returns nulls while the job is still in flight (output_ref is NULL until done)", async () => {
    const { controller } = makeController(row({ status: "queued", outputRef: null }));
    expect(await controller.get(WORKER, JOB)).toEqual({
      status: "queued",
      profile_id: null,
      voice_note_id: null,
    });
  });

  it("surfaces failure through status alone — the raw error_message never ships", async () => {
    const { controller } = makeController(
      row({
        status: "failed",
        outputRef: null,
        // The real shape of this field on an outage: an infrastructure host:port.
        errorMessage: "write CONNECTION_CLOSED db.internal.badabhai:5432",
      }),
    );
    const res = await controller.get(WORKER, JOB);
    expect(res.status).toBe("failed");
    expect(JSON.stringify(res)).not.toContain("db.internal");
    expect(JSON.stringify(res)).not.toContain("5432");
  });

  it("does not pass through an unexpected key added to output_ref later", async () => {
    // The projection names its keys, so a future writer adding something to the
    // jsonb column cannot reach a worker by accident.
    const { controller } = makeController(
      row({ outputRef: { profile_id: "p1", internal_debug_ref: "secret-trace-id" } }),
    );
    expect(JSON.stringify(await controller.get(WORKER, JOB))).not.toContain("secret-trace-id");
  });

  it("ignores a non-string value in output_ref rather than echoing it", async () => {
    const { controller } = makeController(row({ outputRef: { profile_id: { nested: "x" } } }));
    expect(await controller.get(WORKER, JOB)).toEqual({
      status: "completed",
      profile_id: null,
      voice_note_id: null,
    });
  });
});
