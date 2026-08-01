import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ActionsService } from "./actions.service";
import {
  RecordActionSchema,
  RecordActionsBatchSchema,
  type RecordActionDto,
  type RecordActionsBatchDto,
} from "./actions.dto";

/** Records worker behavioural actions into the event store (no PII). */
@Controller("actions")
@UseGuards(InternalServiceGuard)
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Post()
  @HttpCode(201)
  record(
    @Body(new ZodValidationPipe(RecordActionSchema)) dto: RecordActionDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.actions.record(dto, ctx);
  }

  /** Batch flush (offline-tolerant clients) — one DB round-trip. */
  @Post("batch")
  @HttpCode(201)
  recordBatch(
    @Body(new ZodValidationPipe(RecordActionsBatchSchema)) dto: RecordActionsBatchDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.actions.recordBatch(dto, ctx);
  }
}
