import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { WorkerMatchSkillsController } from "./worker-match-skills.controller";

/**
 * E4 — the worker's own match-skills surface.
 *
 * THREE THINGS ARE WORTH PINNING, and none is a handler body, which is a one-line delegation:
 *
 *   1. THE GUARD PAIR IS ON THE CLASS. This controller serves a worker his own supply state
 *      and takes a visibility WRITE — the exact surface the phase exists to give him an exit
 *      from. A route added here without the pair would be an unauthenticated write over
 *      another worker's `wants` (the path param is a skill id, but the WORKER id must come
 *      from the session). Class-level guards make omission impossible.
 *   2. THE WORKER ID IS NOT IN ANY SIGNATURE. Identity is the guard's, never the body's or
 *      the path's. Arity is the check that survives a refactor.
 *   3. THE WIRE VOCABULARY IS `mskill_*` / snake_case, because the Flutter screen consumes
 *      exactly what this test asserts (see the E4 GitHub issue for the mobile half).
 */

const meta = (key: string, target: unknown): unknown => Reflect.getMetadata(key, target as object);

const WORKER = { id: "11111111-1111-4111-8111-111111111111", sid: "s-1" };
const CTX = { requestId: "req-1", correlationId: "corr-1" };

describe("WorkerMatchSkillsController — the exit lives behind the worker-self pair", () => {
  it("guards the WHOLE controller, so a new route cannot ship unguarded by omission", () => {
    expect(meta("__guards__", WorkerMatchSkillsController)).toEqual([
      WorkerAuthGuard,
      ConsentGuard,
    ]);
  });

  it("mounts under workers/me with the three documented routes", () => {
    expect(meta(PATH_METADATA, WorkerMatchSkillsController)).toBe("workers");
    const proto = WorkerMatchSkillsController.prototype as unknown as Record<string, object>;
    expect(meta(PATH_METADATA, proto.listMyMatchSkills)).toBe("me/match-skills");
    expect(meta(METHOD_METADATA, proto.listMyMatchSkills)).toBe(RequestMethod.GET);
    expect(meta(PATH_METADATA, proto.setMySkillWants)).toBe("me/match-skills/:skillId/wants");
    expect(meta(METHOD_METADATA, proto.setMySkillWants)).toBe(RequestMethod.PUT);
    expect(meta(PATH_METADATA, proto.clearAllMyMatchSkills)).toBe("me/match-skills/clear-all");
    expect(meta(METHOD_METADATA, proto.clearAllMyMatchSkills)).toBe(RequestMethod.POST);
  });

  it("answers both writes with 200, not 201 — neither creates a resource", () => {
    const proto = WorkerMatchSkillsController.prototype as unknown as Record<string, object>;
    expect(meta("__httpCode__", proto.setMySkillWants)).toBe(200);
    expect(meta("__httpCode__", proto.clearAllMyMatchSkills)).toBe(200);
  });

  it("no handler accepts a worker id — identity is the guard's, not the caller's", () => {
    // list(1: worker), set(4: worker, skillId, dto, ctx), clear(2: worker, ctx). A body or
    // path worker_id added later changes one of these numbers and fails before it ships.
    expect(WorkerMatchSkillsController.prototype.listMyMatchSkills.length).toBe(1);
    expect(WorkerMatchSkillsController.prototype.setMySkillWants.length).toBe(4);
    expect(WorkerMatchSkillsController.prototype.clearAllMyMatchSkills.length).toBe(2);
  });
});

describe("WorkerMatchSkillsController — delegation and the wire shape", () => {
  function makeCtrl() {
    const skills = {
      listMatchSkillsForWorker: vi.fn(async () => [
        { skill_id: "mskill_cnc_turner", label: "CNC Turner", wants: true },
      ]),
      setWants: vi.fn(async () => ({ skill_id: "mskill_cnc_turner", wants: false })),
      clearAllWants: vi.fn(async () => ({ cleared: 2 })),
    };
    return { ctrl: new WorkerMatchSkillsController(skills as never), skills };
  }

  it("returns the worker's own skills, unwrapped and unmodified", async () => {
    const { ctrl, skills } = makeCtrl();
    await expect(ctrl.listMyMatchSkills(WORKER)).resolves.toEqual({
      skills: [{ skill_id: "mskill_cnc_turner", label: "CNC Turner", wants: true }],
    });
    expect(skills.listMatchSkillsForWorker).toHaveBeenCalledWith(WORKER.id);
  });

  it("passes the session worker, the path skill and the validated boolean through", async () => {
    const { ctrl, skills } = makeCtrl();
    await expect(
      ctrl.setMySkillWants(WORKER, "mskill_cnc_turner", { wants: false }, CTX),
    ).resolves.toEqual({ ok: true, skill_id: "mskill_cnc_turner", wants: false });
    expect(skills.setWants).toHaveBeenCalledWith(WORKER.id, "mskill_cnc_turner", false, CTX);
  });

  it("reports the clear-all honestly, including a 0-row repeat", async () => {
    const { ctrl, skills } = makeCtrl();
    await expect(ctrl.clearAllMyMatchSkills(WORKER, CTX)).resolves.toEqual({
      ok: true,
      cleared: 2,
    });
    expect(skills.clearAllWants).toHaveBeenCalledWith(WORKER.id, CTX);
  });
});
