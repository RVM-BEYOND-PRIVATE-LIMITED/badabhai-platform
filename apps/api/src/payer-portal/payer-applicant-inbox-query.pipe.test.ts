import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerApplicantInboxQueryPipe } from "./payer-applicant-inbox-query.pipe";
import { PayerApplicantInboxController } from "./payer-applicant-inbox.controller";
import { PayerApplicantInboxQuerySchema } from "./payer-applicant-inbox.dto";
import { encodeInboxCursor } from "./payer-applicant-inbox.cursor";

/**
 * `GET /payer/reach/applicants` query validation, by flag (owner ruling 2026-10-07). OFF must be
 * the pre-stage query exactly — `?stage=` the same 400 body as before; ON adds the filter.
 */

const pipe = (enabled: boolean) =>
  new PayerApplicantInboxQueryPipe({ PAYER_APPLICANT_STAGES_ENABLED: enabled });

/** The 400 body the pipe throws, or null when it parses. */
function badRequestBody(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse();
  }
}

const CURSOR = encodeInboxCursor({
  appliedKey: "2026-10-01T10:00:00.000007Z",
  applicationId: "44444444-4444-4444-8444-000000000007",
});

describe("PayerApplicantInboxQueryPipe — flag OFF is the pre-stage query, byte for byte", () => {
  it.each([
    [{ stage: "shortlist" }],
    [{ stage: "new" }],
    [{ stage: "" }],
    [{ limit: "5", stage: "passed" }],
  ])("?stage= is the SAME 400 the old strict schema gives (%j)", (query) => {
    const before = badRequestBody(() =>
      new ZodValidationPipe(PayerApplicantInboxQuerySchema).transform(query),
    );
    expect(before).not.toBeNull();
    expect(badRequestBody(() => pipe(false).transform(query))).toEqual(before);
  });

  it("everything the old query accepted parses to the same value", () => {
    for (const query of [
      {},
      { limit: "7" },
      { cursor: CURSOR },
      { postingId: "0c000000-0000-4000-8000-0000000000a1" },
    ]) {
      expect(pipe(false).transform(query)).toEqual(
        new ZodValidationPipe(PayerApplicantInboxQuerySchema).transform(query),
      );
    }
  });
});

describe("PayerApplicantInboxQueryPipe — flag ON adds the optional stage filter", () => {
  it.each(["new", "shortlist", "passed"] as const)("?stage=%s parses", (stage) => {
    expect(pipe(true).transform({ stage })).toEqual({ stage, limit: 20, cursor: undefined });
  });

  it("composes with postingId, limit and cursor", () => {
    const postingId = "0c000000-0000-4000-8000-0000000000a1";
    expect(
      pipe(true).transform({ stage: "passed", postingId, limit: "5", cursor: CURSOR }),
    ).toEqual({
      stage: "passed",
      postingId,
      limit: 5,
      cursor: {
        appliedKey: "2026-10-01T10:00:00.000007Z",
        applicationId: "44444444-4444-4444-8444-000000000007",
      },
    });
  });

  it("absent stage = no filter", () => {
    expect(pipe(true).transform({})).not.toHaveProperty("stage", expect.anything());
  });

  it.each([
    [{ stage: "contacted" }],
    [{ stage: "Shortlist" }],
    [{ stage: "" }],
    [{ stage: ["new", "passed"] }],
    [{ stage: "new", payer_id: "aaaaaaaa-0000-4000-8000-00000000000a" }],
  ])("a stage outside the vocabulary, a repeated stage, or a smuggled key is a 400 (%j)", (q) => {
    expect(badRequestBody(() => pipe(true).transform(q))).not.toBeNull();
  });
});

describe("the inbox route validates its query with this pipe", () => {
  it("GET /payer/reach/applicants' @Query uses PayerApplicantInboxQueryPipe (not a fixed schema)", () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PayerApplicantInboxController,
      "list",
    ) as Record<string, { pipes: unknown[] }>;
    const query = Object.entries(args).find(([k]) => k.startsWith("4:"))?.[1]; // RouteParamtypes.QUERY = 4
    expect(query?.pipes).toEqual([PayerApplicantInboxQueryPipe]);
  });
});
