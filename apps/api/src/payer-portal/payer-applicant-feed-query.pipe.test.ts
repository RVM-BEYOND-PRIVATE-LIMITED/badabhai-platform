import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { PayerApplicantFeedQueryPipe } from "./payer-applicant-feed-query.pipe";
import { PayerReachController } from "./payer-reach.controller";

/**
 * `GET /payer/reach/jobs/:jobId/applicants` query validation, by flag (#2737).
 *
 * OFF must be the pre-#2737 route exactly: no query contract, every query key ignored.
 * ON adds `?stage=`, defaulting to `new` so a handled applicant is never returned by a
 * client that does not opt into the full board.
 */

const pipe = (enabled: boolean) =>
  new PayerApplicantFeedQueryPipe({ PAYER_APPLICANT_STAGES_ENABLED: enabled });

function badRequestBody(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse();
  }
}

describe("PayerApplicantFeedQueryPipe — flag OFF is the pre-stage route, byte for byte", () => {
  it.each([
    [{}],
    [{ stage: "new" }],
    [{ stage: "all" }],
    [{ stage: "contacted" }],
    [{ stage: ["new", "passed"] }],
    [{ payer_id: "aaaaaaaa-0000-4000-8000-00000000000a" }],
    [{ anything: "goes" }],
  ])("ignores the query exactly as the route always did (%j)", (query) => {
    expect(pipe(false).transform(query)).toEqual({});
  });
});

describe("PayerApplicantFeedQueryPipe — flag ON adds the optional stage filter", () => {
  it("absent stage defaults to `new` — the actionable feed (#2737)", () => {
    expect(pipe(true).transform({})).toEqual({ stage: "new" });
  });

  it.each(["new", "shortlist", "passed", "all"] as const)("?stage=%s parses", (stage) => {
    expect(pipe(true).transform({ stage })).toEqual({ stage });
  });

  it.each([
    [{ stage: "contacted" }],
    [{ stage: "Shortlist" }],
    [{ stage: "" }],
    [{ stage: ["new", "passed"] }],
  ])("a stage outside the vocabulary or a repeated stage is a 400 (%j)", (q) => {
    expect(badRequestBody(() => pipe(true).transform(q))).not.toBeNull();
  });

  it("ignores an unknown key but never reads a payer_id (the session payer is the identity)", () => {
    const parsed = pipe(true).transform({
      stage: "passed",
      payer_id: "aaaaaaaa-0000-4000-8000-00000000000a",
      anything: "goes",
    });
    expect(parsed).toEqual({ stage: "passed" });
    expect(JSON.stringify(parsed)).not.toContain("aaaaaaaa");
  });
});

describe("the per-posting feed route validates its query with this pipe", () => {
  it("GET /payer/reach/jobs/:jobId/applicants' @Query uses PayerApplicantFeedQueryPipe", () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PayerReachController,
      "applicants",
    ) as Record<string, { pipes: unknown[] }>;
    const query = Object.entries(args).find(([k]) => k.startsWith("4:"))?.[1]; // RouteParamtypes.QUERY = 4
    expect(query?.pipes).toEqual([PayerApplicantFeedQueryPipe]);
  });
});
