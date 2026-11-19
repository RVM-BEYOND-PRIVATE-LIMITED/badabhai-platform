import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { CampusErrorCode } from "./campus-link.contract";
import { StudentNotAvailableError } from "./institute-link.service";
import {
  GrantCompanyNotFoundError,
  GrantNotFoundError,
  GrantRefConflictError,
} from "./institute-search-grants.service";
import { RvmStudentApiUnavailableError } from "./rvm-student-api.client";
import {
  WaiverCompanyNotFoundError,
  WaiverEndDateDiffersError,
  WaiverEndDateInvalidError,
  WaiverEndDatesOffError,
  WaiverPostingNotFoundError,
} from "../rvm-waivers/rvm-waivers.service";

/** A Campus refusal with its contract code (`error.code` in the api's envelope). */
export class CampusRefusal extends Error {
  constructor(
    readonly code: CampusErrorCode,
    readonly status: 404 | 409,
  ) {
    super(code);
    this.name = "CampusRefusal";
  }
}

/**
 * Turns a Campus route's domain error into the published HTTP answer (contract "Errors" table).
 * A not-found is the neutral 404 with no code. Anything unknown propagates (a 500): never a
 * guessed success.
 */
export function toCampusHttpError(err: unknown): unknown {
  if (err instanceof HttpException) return err;
  if (err instanceof StudentNotAvailableError) {
    return new ConflictException({ code: "STUDENT_NOT_AVAILABLE" });
  }
  if (err instanceof RvmStudentApiUnavailableError) {
    return new ServiceUnavailableException({ code: "RVM_UNAVAILABLE" });
  }
  if (err instanceof GrantRefConflictError) {
    return new ConflictException({ code: "EXTERNAL_REF_CONFLICT" });
  }
  if (err instanceof GrantCompanyNotFoundError || err instanceof GrantNotFoundError) {
    return new NotFoundException();
  }
  // #2750 item 5: an unknown or barred company, or a job that is not that company's.
  if (err instanceof WaiverCompanyNotFoundError || err instanceof WaiverPostingNotFoundError) {
    return new NotFoundException();
  }
  // #2778: an end date BadaBhai cannot take (switched off, in the past) is a validation failure;
  // a waiver already in force with another end date is a 409 (clear it, then set it again).
  if (err instanceof WaiverEndDatesOffError || err instanceof WaiverEndDateInvalidError) {
    return new BadRequestException({
      code: "VALIDATION_FAILED",
      message: "Validation failed",
      issues: [{ path: "ends_on", message: err.message }],
    });
  }
  if (err instanceof WaiverEndDateDiffersError) {
    return new ConflictException({ code: "WAIVER_END_DATE_DIFFERS" });
  }
  if (err instanceof CampusRefusal) {
    return err.status === 404 ? new NotFoundException() : new ConflictException({ code: err.code });
  }
  return err;
}

/** Runs a Campus route's work and answers its domain errors as the contract says. */
export async function campusCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw toCampusHttpError(err);
  }
}
