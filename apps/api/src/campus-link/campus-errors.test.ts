import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { CampusRefusal, toCampusHttpError } from "./campus-errors";
import { StudentNotAvailableError } from "./institute-link.service";
import {
  GrantCompanyNotFoundError,
  GrantNotFoundError,
  GrantRefConflictError,
} from "./institute-search-grants.service";
import { RvmStudentApiUnavailableError } from "./rvm-student-api.client";

/** #2752 — every Campus domain error answers the contract's status and code (API reference). */
function answerOf(err: unknown): { status: number; code: unknown } {
  const http = toCampusHttpError(err);
  expect(http).toBeInstanceOf(HttpException);
  const response = (http as HttpException).getResponse() as { code?: unknown };
  return { status: (http as HttpException).getStatus(), code: response.code };
}

describe("toCampusHttpError", () => {
  it.each([
    [new StudentNotAvailableError(), 409, "STUDENT_NOT_AVAILABLE"],
    [new RvmStudentApiUnavailableError("timeout"), 503, "RVM_UNAVAILABLE"],
    [new GrantRefConflictError(), 409, "EXTERNAL_REF_CONFLICT"],
    [new CampusRefusal("POSTING_NOT_APPROVED", 409), 409, "POSTING_NOT_APPROVED"],
    [new CampusRefusal("AUDIENCE_EXCLUDES_RVM", 409), 409, "AUDIENCE_EXCLUDES_RVM"],
    [new CampusRefusal("COMPANY_NOT_CAMPUS_CREATED", 409), 409, "COMPANY_NOT_CAMPUS_CREATED"],
  ])("answers %s as %i %s", (err, status, code) => {
    expect(answerOf(err)).toEqual({ status, code });
  });

  it.each([
    [new GrantNotFoundError()],
    [new GrantCompanyNotFoundError()],
    [new CampusRefusal("POSTING_NOT_OPEN", 404)],
  ])("answers %s as the neutral 404 with no code", (err) => {
    expect(answerOf(err)).toEqual({ status: 404, code: undefined });
  });

  it("passes an HttpException through untouched", () => {
    const own = new ConflictException({ code: "REQUEST_IN_PROGRESS" });
    expect(toCampusHttpError(own)).toBe(own);
    expect(toCampusHttpError(new NotFoundException())).toBeInstanceOf(NotFoundException);
  });

  it("lets an unknown error propagate as itself (a 500, never a guessed success)", () => {
    const boom = new Error("boom");
    expect(toCampusHttpError(boom)).toBe(boom);
  });
});
