import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { RelayService } from "./relay.service";
import { WorkerRelayReplySchema, type WorkerRelayReplyDto } from "./relay.dto";

/**
 * The worker half of the in-app relay (E0 item 3, `docs/agent/phases/E0_BUILD.md`).
 *
 * Worker-self + consent-gated — the same pair the Alerts feed uses. The worker id comes
 * from `@CurrentWorker` (the bearer token), never a path/body value, and every route
 * re-runs the resolution ladder at use time: a withdrawn `employer_messaging` closes the
 * worker's own read and reply paths too (fail closed, the ONE neutral body).
 *
 * NO COUNTERPARTY IDENTITY IS RETURNED, EVER. The decision doc defers "what a payer may be
 * identified as" to its own owner ruling; until then a thread is an opaque `unlock_id`.
 */
@Controller("workers/me/relay-threads")
export class WorkerRelayController {
  constructor(private readonly relay: RelayService) {}

  /** The caller's own threads, newest activity first. Own-data read; opening re-checks. */
  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  list(@CurrentWorker() worker: AuthenticatedWorker) {
    return this.relay.listThreads(worker.id);
  }

  /** One thread's messages, oldest-first. Resolution-gated (neutral on failure). */
  @Get(":unlockId")
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  read(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @CurrentWorker() worker: AuthenticatedWorker,
  ) {
    return this.relay.readThread(worker.id, unlockId);
  }

  /** Reply with free text — the act that opens the thread to free text both ways (§B). */
  @Post(":unlockId/reply")
  @HttpCode(201)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  reply(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @Body(new ZodValidationPipe(WorkerRelayReplySchema)) dto: WorkerRelayReplyDto,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ctx() ctx: RequestContext,
  ) {
    return this.relay.replyFromWorker(worker.id, unlockId, dto, ctx);
  }

  /** Mark inbound messages read. Emits the audit event; no payer-visible receipt exists. */
  @Post(":unlockId/read")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  markRead(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ctx() ctx: RequestContext,
  ) {
    return this.relay.markThreadRead(worker.id, unlockId, ctx);
  }
}
