import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
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
