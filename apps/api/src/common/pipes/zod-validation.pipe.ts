import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, infer as ZodInfer } from "zod";

/**
 * Validates and parses an incoming value against a Zod schema. Used instead of
 * class-validator so we share a single validation library (Zod) with
 * @badabhai/validators and the event/AI contracts.
 *
 *   @Post() create(@Body(new ZodValidationPipe(CreateXSchema)) dto: CreateX) {}
 */
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): ZodInfer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
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
