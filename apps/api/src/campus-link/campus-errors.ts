import {
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
