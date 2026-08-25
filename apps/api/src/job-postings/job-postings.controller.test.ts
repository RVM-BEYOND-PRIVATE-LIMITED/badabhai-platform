import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { JobPostingsController } from "./job-postings.controller";
import type { JobPostingsService } from "./job-postings.service";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const ID = "11111111-1111-4111-8111-111111111111";
/** The SESSION admin — distinct from any id a body could carry. */
const ADMIN: AuthenticatedAdmin = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "ops_admin",
  sid: "session-1",
};

function make() {
  const jobPostings = {
    create: vi.fn(async () => ({ id: ID })),
    list: vi.fn(async () => ({ job_postings: [] })),
    getOne: vi.fn(async () => ({ id: ID })),
    update: vi.fn(async () => ({ id: ID })),
    close: vi.fn(async () => ({ id: ID, status: "closed" })),
    verify: vi.fn(async () => ({ id: ID, verification_status: "verified", verified: true })),
    reject: vi.fn(async () => ({ id: ID, verification_status: "rejected", verified: false })),
    opsWidenReach: vi.fn(
      async (_id: string, _addSkillIds: string[], _actorId: string, _ctx: RequestContext) => ({
        jobPostingId: ID,
      }),
    ),
  };
  return {
    controller: new JobPostingsController(jobPostings as unknown as JobPostingsService),
    jobPostings,
  };
}

describe("JobPostingsController (thin) — delegation", () => {
  it("create delegates dto + ctx", async () => {
    const { controller, jobPostings } = make();
    const dto = { org_label: "o", role_title: "r", vacancy_band: "1", created_by: ID };
    await controller.create(dto as never, CTX);
    expect(jobPostings.create).toHaveBeenCalledWith(dto, CTX);
  });

  it("list delegates the query", async () => {
    const { controller, jobPostings } = make();
    await controller.list({ status: "open" } as never);
    expect(jobPostings.list).toHaveBeenCalledWith({ status: "open" });
  });

  it("getOne delegates the id", async () => {
    const { controller, jobPostings } = make();
    await controller.getOne(ID);
    expect(jobPostings.getOne).toHaveBeenCalledWith(ID);
  });

  it("update delegates id + dto + ctx", async () => {
    const { controller, jobPostings } = make();
    const dto = { role_title: "r2" };
    await controller.update(ID, dto as never, CTX);
    expect(jobPostings.update).toHaveBeenCalledWith(ID, dto, CTX);
  });

  it("close delegates id + ctx", async () => {
    const { controller, jobPostings } = make();
    await controller.close(ID, CTX);
    expect(jobPostings.close).toHaveBeenCalledWith(ID, CTX);
  });

  it("verify delegates id + ctx", async () => {
    const { controller, jobPostings } = make();
    await controller.verify(ID, CTX);
    expect(jobPostings.verify).toHaveBeenCalledWith(ID, CTX);
  });

  it("reject delegates id + ctx", async () => {
    const { controller, jobPostings } = make();
    await controller.reject(ID, CTX);
    expect(jobPostings.reject).toHaveBeenCalledWith(ID, CTX);
  });
});

// #1213 — the AUDITED actor on a Policy 27 widen must be the AUTHENTICATED admin
// session's own id, never a value the request body supplied. `ReachWidenSchema` no
// longer has an `ops_actor` field at all (see `match.dto.test.ts`); these tests pin the
// controller's half of the guarantee — even a dto object that carries a spoofed
// `ops_actor` (as an attacker who bypassed/predates the Zod strip might attempt) can
// never reach the service, because the controller reads the actor id from
// `@CurrentAdmin()`, not from the dto, and the dto TYPE has no such field to read.
describe("JobPostingsController — widenReach (Policy 27, #1213)", () => {
  it("delegates id + add_skill_ids + the SESSION ADMIN's own id (never a body value) to the service", async () => {
    const { controller, jobPostings } = make();
    const dto = { add_skill_ids: ["mskill_hmc_operator"] };
    await controller.widenReach(ID, dto as never, ADMIN, CTX);
    expect(jobPostings.opsWidenReach).toHaveBeenCalledWith(ID, dto.add_skill_ids, ADMIN.id, CTX);
  });

  it("ignores a spoofed ops_actor riding the dto — the SESSION admin's id wins regardless", async () => {
    const { controller, jobPostings } = make();
    const SPOOFED = "99999999-9999-4999-8999-999999999999";
    // A dto shape that should not exist at the type level; cast to simulate a caller
    // that got a value onto the object anyway (e.g. a future refactor regression).
    const dto = { add_skill_ids: ["mskill_hmc_operator"], ops_actor: SPOOFED };
    await controller.widenReach(ID, dto as never, ADMIN, CTX);
    const [, , actorArg] = jobPostings.opsWidenReach.mock.calls[0]!;
    expect(actorArg).toBe(ADMIN.id);
    expect(actorArg).not.toBe(SPOOFED);
  });
});
