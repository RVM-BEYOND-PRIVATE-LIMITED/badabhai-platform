import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
  type PipeTransform,
} from "@nestjs/common";
import type { Request } from "express";
import type { ZodTypeAny, infer as ZodInfer } from "zod";
import { CAMPUS_IDEMPOTENCY_KEY_HEADER, CampusIdempotencyKeySchema } from "./campus-link.contract";

/**
 * Validates a Campus route's path, query or body against its contract schema. The api's own
 * `ZodValidationPipe` answers without a code; Campus keys on `error.code`, so this one answers
 * `VALIDATION_FAILED` with the same issue list.
 */
export class CampusZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): ZodInfer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "Validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path.join(".") || "(root)",
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}

/**
 * The `Idempotency-Key` every Campus write carries (contract: 8 to 200 characters of
 * `A-Z a-z 0-9 . _ : -`). Missing or malformed → 400 `IDEMPOTENCY_KEY_REQUIRED`, before the route
 * does anything.
 */
export const CampusIdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const raw = ctx.switchToHttp().getRequest<Request>().headers[CAMPUS_IDEMPOTENCY_KEY_HEADER];
    const parsed = CampusIdempotencyKeySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    return parsed.data;
  },
);
