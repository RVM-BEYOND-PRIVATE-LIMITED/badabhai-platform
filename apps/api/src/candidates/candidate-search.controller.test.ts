import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { CandidateSearchSchema } from "./candidate-search.dto";
import {
  CANDIDATE_FILTERS_RATE_SCOPE,
  CANDIDATE_SEARCH_RATE_SCOPE,
  CandidateSearchController,
} from "./candidate-search.controller";
import type { CandidateSearchService } from "./candidate-search.service";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const PAYER = { id: "11111111-1111-4111-8111-111111111111" } as AuthenticatedPayer;

function setup() {
  const order: string[] = [];
  const service = {
    search: vi.fn(async () => {
      order.push("search");
      return { total: 0, matched: 0, unrecorded: 0, filtered: false, strict: false, candidates: [], nextCursor: null };
    }),
    filters: vi.fn(async () => {
      order.push("filters");
      return { roles: [], industries: [], experienceBuckets: [], cities: [], maxRoles: 5 };
    }),
  };
  const rateLimit = {
    assertWithinHourlyCap: vi.fn(async () => void order.push("cap")),
  };
  const config = { PAYER_CANDIDATE_SEARCH_MAX_PER_HOUR: 120 } as ServerConfig;
  const controller = new CandidateSearchController(
    service as unknown as CandidateSearchService,
    rateLimit as unknown as PayerDisclosureRateLimit,
    config,
  );
  return { controller, service, rateLimit, order };
}

describe("CandidateSearchController", () => {
  it("charges the payer's own search bucket BEFORE any read", async () => {
    const t = setup();
    await t.controller.search(CandidateSearchSchema.parse({}), PAYER, CTX);
    expect(t.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER.id, {
      scope: CANDIDATE_SEARCH_RATE_SCOPE,
      cap: 120,
    });
    expect(t.order).toEqual(["cap", "search"]);
  });

  it("a capped payer touches no data (the 429 propagates, the service is never called)", async () => {
    const t = setup();
    t.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(
      new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(t.controller.search(CandidateSearchSchema.parse({}), PAYER, CTX)).rejects.toMatchObject({
      status: 429,
    });
    expect(t.service.search).not.toHaveBeenCalled();
  });

  it("searches as the SESSION payer", async () => {
    const t = setup();
    const dto = CandidateSearchSchema.parse({ strict: true });
    await t.controller.search(dto, PAYER, CTX);
    expect(t.service.search).toHaveBeenCalledWith(PAYER.id, dto, CTX);
  });

  it("charges the filters route its OWN bucket before the read (never the search budget)", async () => {
    const t = setup();
    await t.controller.filters(PAYER);
    expect(t.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER.id, {
      scope: CANDIDATE_FILTERS_RATE_SCOPE,
      cap: 120,
    });
    expect(CANDIDATE_FILTERS_RATE_SCOPE).not.toBe(CANDIDATE_SEARCH_RATE_SCOPE);
    expect(t.order).toEqual(["cap", "filters"]);
  });

  it("a capped payer gets no filter read either", async () => {
    const t = setup();
    t.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(
      new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(t.controller.filters(PAYER)).rejects.toMatchObject({ status: 429 });
    expect(t.service.filters).not.toHaveBeenCalled();
  });

  it("is mounted at payer/candidates with POST search (200) and GET filters", () => {
    expect(Reflect.getMetadata("path", CandidateSearchController)).toBe("payer/candidates");
    const proto = CandidateSearchController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata("path", proto.search!)).toBe("search");
    expect(Reflect.getMetadata("method", proto.search!)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata("__httpCode__", proto.search!)).toBe(200);
    expect(Reflect.getMetadata("path", proto.filters!)).toBe("filters");
    expect(Reflect.getMetadata("method", proto.filters!)).toBe(0); // RequestMethod.GET
  });
});
