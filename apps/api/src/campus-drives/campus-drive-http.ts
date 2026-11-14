import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { RequestContext } from "../common/request-context";
import { isCanonicalUuid } from "../common/uuid";
import { CAMPUS_CALL_ID_HEADER } from "../campus-link/campus-link.contract";
import { DriveIdempotencyKeySchema } from "./campus-drive-requests.dto";

/** The `reason` on the 400 a create without a valid `Idempotency-Key` gets. */
export const DRIVE_IDEMPOTENCY_KEY_REQUIRED = "idempotency_key_required" as const;

/**
 * #2746 PR 6 — the `Idempotency-Key` of `POST /payer/campus-drive-requests`. REQUIRED, unlike the
 * payer purchase routes where it is optional: the key is stored on the row
 * (`campus_drive_requests.idempotency_key`, NOT NULL, unique per company), so it is the lasting
 * guard against a duplicate request long after Redis has forgotten it. Missing or malformed → the
 * house payer 400 with `reason: "idempotency_key_required"`, before the route does anything.
 */
export const DriveIdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const raw = ctx.switchToHttp().getRequest<Request>().headers["idempotency-key"];
    const parsed = DriveIdempotencyKeySchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message:
          "An Idempotency-Key header is required: 8 to 200 characters of A-Z a-z 0-9 . _ : -",
        reason: DRIVE_IDEMPOTENCY_KEY_REQUIRED,
      });
    }
    return parsed.data;
  },
);

/** The Campus call a decision arrived on: tracing ids, and the guard's audit-row id. */
export interface CampusDriveCall {
  ctx: RequestContext;
  /** `x-campus-call-id`: the id of `CampusServiceGuard`'s per-call `audit_logs` row. */
  callId: string;
}

/**
 * The guard's call id, which it sets on the response before any handler runs. The decision's own
 * audit row names it, so a decision without one does not proceed (an unaudited call fails closed,
 * as in the guard). Absent only if the route were mounted without the guard. The same rule as
 * #2746 PR 5's `campusCallIdOf` (`campus-link/campus-call.ts`, not on this branch's base): one of
 * the two goes when the branches meet.
 */
export function driveCallIdOf(res: Response): string {
  const callId = res.getHeader(CAMPUS_CALL_ID_HEADER);
  if (typeof callId !== "string" || !isCanonicalUuid(callId)) {
    throw new InternalServerErrorException();
  }
  return callId;
}
