import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ProfilesController } from "./profiles.controller";
import type { ProfilesService } from "./profiles.service";
import type { ExtractedCorrectionsService } from "./extracted-corrections.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid" };

function make() {
  const profiles = {
    extract: vi.fn(async () => ({ ai_job_id: "j", status: "queued" })),
    confirm: vi.fn(async () => ({ profile_id: "p", profile_status: "confirmed" })),
  };
  const corrections = {
    correctExtracted: vi.fn(async () => ({
      profile_id: "p",
      corrections_applied: 1,
      correction_count: 1,
    })),
  };
  return {
    controller: new ProfilesController(
      profiles as unknown as ProfilesService,
      corrections as unknown as ExtractedCorrectionsService,
    ),
    profiles,
    corrections,
  };
}

describe("ProfilesController (thin) — worker from token, never the body", () => {
  it("extract builds the service input from the authed worker + body session_id", async () => {
    const { controller, profiles } = make();
    await controller.extract(WORKER, { session_id: "sess" } as never, CTX);
    expect(profiles.extract).toHaveBeenCalledWith(
      { worker_id: WORKER.id, session_id: "sess" },
      CTX,
    );
  });

  it("extract passes session_id null when omitted", async () => {
    const { controller, profiles } = make();
    await controller.extract(WORKER, {} as never, CTX);
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER.id, session_id: null }, CTX);
  });

  it("confirm builds the service input from the authed worker + body profile_id", async () => {
    const { controller, profiles } = make();
    await controller.confirm(WORKER, { profile_id: "p1" } as never, CTX);
    expect(profiles.confirm).toHaveBeenCalledWith({ worker_id: WORKER.id, profile_id: "p1" }, CTX);
  });

  it("correctExtracted builds the service input from the authed worker + body ids", async () => {
    const { controller, corrections } = make();
    const dto = {
      profile_id: "p1",
      session_id: "s1",
      corrections: [{ field: "skills", skill_ids: ["skill_turning"] }],
    } as never;
    await controller.correctExtracted(WORKER, dto, CTX);
    expect(corrections.correctExtracted).toHaveBeenCalledWith(
      {
        worker_id: WORKER.id,
        profile_id: "p1",
        session_id: "s1",
        corrections: [{ field: "skills", skill_ids: ["skill_turning"] }],
      },
      CTX,
    );
  });
});
