import { InternalServerErrorException } from "@nestjs/common";
import type { Response } from "express";
import type { RequestContext } from "../common/request-context";
import { isCanonicalUuid } from "../common/uuid";
import { CAMPUS_CALL_ID_HEADER } from "./campus-link.contract";

/** The Campus call a write arrived on: tracing ids, and the guard's audit-row id. */
export interface CampusCall {
  ctx: RequestContext;
  /** `x-campus-call-id`: the id of `CampusServiceGuard`'s per-call `audit_logs` row. */
  callId: string;
}

/**
 * The guard's call id, which it sets on the response before any handler runs. A write's own audit
 * row names it, so a write without one does not proceed (an unaudited call fails closed, as in the
 * guard). Absent only if a route were mounted without the guard.
 */
export function campusCallIdOf(res: Response): string {
  const callId = res.getHeader(CAMPUS_CALL_ID_HEADER);
  if (typeof callId !== "string" || !isCanonicalUuid(callId)) {
    throw new InternalServerErrorException();
  }
  return callId;
}
