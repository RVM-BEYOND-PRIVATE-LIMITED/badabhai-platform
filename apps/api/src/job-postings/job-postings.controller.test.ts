import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { JobPostingsController } from "./job-postings.controller";
import type { JobPostingsService } from "./job-postings.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const ID = "11111111-1111-4111-8111-111111111111";

function make() {
  const jobPostings = {
    create: vi.fn(async () => ({ id: ID })),
    list: vi.fn(async () => ({ job_postings: [] })),
    getOne: vi.fn(async () => ({ id: ID })),
    update: vi.fn(async () => ({ id: ID })),
    close: vi.fn(async () => ({ id: ID, status: "closed" })),
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
});
