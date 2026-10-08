import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import { ResumeDisclosureService } from "../disclosures/resume-disclosure.service";
import { PayerJobPostingsController } from "./payer-job-postings.controller";
import { PayerPostingPlansService } from "./payer-posting-plans.service";

/**
 * ADR-0053 §5.4 (P2c review M-3) — `GET /payer/job-postings` and `GET /payer/job-postings/:id`
 * resolve the caller's tenancy EXACTLY ONCE per request, whatever the page size.
 *
 * Wired from the REAL controller, the REAL posting seam (`PayerPostingPlansService`) and the REAL
 * `ResumeDisclosureService`, over ONE real resolver whose `resolve` is spied. Only the data
 * layer is faked: the postings read (honouring the scope it is handed, as `JobPostingsService`'s
 * `*InScope` reads do), the plan stats, and the disclosure repository's two counts. A
 * per-posting download count that resolved on its own — the shape this replaced — turns one
 * resolution into 1 + N, and this file goes red.
 */

const ANCHOR = "aaaaaaaa-0000-4000-8000-00000000000a";
const MEMBER = "bbbbbbbb-0000-4000-8000-00000000000b";
const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;
const P1 = "dddddddd-0000-4000-8000-00000000000d";
const P2 = "eeeeeeee-0000-4000-8000-00000000000e";
const P3 = "ffffffff-0000-4000-8000-00000000000f";
const B: AuthenticatedPayer = { id: MEMBER, sid: "sid-b", role: "employer" };
const STATS = {
  plan_tier: null,
  applicant_visibility_quota: null,
  applicants_viewed_count: null,
  boosted: false,
};

function wire() {
  const tenancy = resolverOver(ON, [{ anchor: ANCHOR, members: [MEMBER] }]);
  const resolve = vi.spyOn(tenancy, "resolve");
  const owns = (scope: PayerTenantScope) => scope.tenantKey === ANCHOR;
  const jobPostings = {
    listInScope: vi.fn(async (scope: PayerTenantScope) =>
      owns(scope) ? [{ id: P1 }, { id: P2 }, { id: P3 }] : [],
    ),
    getOneInScope: vi.fn(async (id: string, scope: PayerTenantScope) => {
      if (!owns(scope)) throw new Error("not found");
      return { id };
    }),
  };
  const plans = { getPostingStats: vi.fn(async (_id: string, _tenant: TenantKey) => STATS) };
  const disclosureRepo = {
    // The page: P1 has two downloads, P3 one, P2 none (absent from the grouped result).
    countDisclosedForPostings: vi.fn(
      async (_ids: readonly string[], _tenant: TenantKey) =>
        new Map([
          [P1, 2],
          [P3, 1],
        ]),
    ),
    countDisclosedForPosting: vi.fn(async (_id: string, _tenant: TenantKey) => 4),
  };
  const disclosures = new ResumeDisclosureService(
    disclosureRepo as never,
    {} as never, // ConsentRepository — no disclosure is requested here
    {} as never, // WorkersRepository — likewise
    {} as never, // PiiCryptoService
    {} as never, // ResumeRenderer
    {} as never, // StorageService
    {} as never, // WorkerAttributesRepository
    {} as never, // WorkerEmploymentRepository
    {} as never, // WorkerQualificationsRepository
    {} as never, // WorkerOccupationsRepository
    {} as never, // EventsService
    {} as never, // ServerConfig
    tenancy,
  );
  const seam = new PayerPostingPlansService(
    jobPostings as never,
    plans as never,
    disclosures,
    tenancy,
  );
  const controller = new PayerJobPostingsController(
    {} as never, // JobPostingsService — the reads go through the seam
    seam,
    {} as never, // RequestIdempotency — no purchase here
  );
  return { controller, resolve, disclosureRepo };
}

describe("GET /payer/job-postings(/:id) — ONE tenant resolution per request (ADR-0053 §5.4)", () => {
  it("a page of three postings resolves once, and reads its download counts in ONE grouped query", async () => {
    const w = wire();
    const page = await w.controller.list({}, B);

    expect(w.resolve).toHaveBeenCalledTimes(1);
    expect(w.resolve).toHaveBeenCalledWith(MEMBER);
    expect(page.map((p) => [p.id, p.disclosures_count])).toEqual([
      [P1, 2],
      [P2, 0],
      [P3, 1],
    ]);
    expect(w.disclosureRepo.countDisclosedForPostings).toHaveBeenCalledTimes(1);
    expect(w.disclosureRepo.countDisclosedForPostings).toHaveBeenCalledWith([P1, P2, P3], ANCHOR);
    expect(w.disclosureRepo.countDisclosedForPosting).not.toHaveBeenCalled();
  });

  it("the single read resolves once too, and counts that posting's downloads under the org's key", async () => {
    const w = wire();
    const one = await w.controller.getOne(P2, B);

    expect(w.resolve).toHaveBeenCalledTimes(1);
    expect(one).toMatchObject({ id: P2, disclosures_count: 4 });
    expect(w.disclosureRepo.countDisclosedForPosting).toHaveBeenCalledWith(P2, ANCHOR);
    expect(w.disclosureRepo.countDisclosedForPostings).not.toHaveBeenCalled();
  });
});
