import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ChatCompanionService } from "./chat-companion.service";
import { CompanionMessageSchema, type CompanionMessageDto } from "./chat-companion.dto";

/**
 * The post-completion Bada Bhai companion (ADR-0044). HTTP only — every decision is in
 * {@link ChatCompanionService}.
 *
 * Worker-authenticated and consent-gated, in that order (ConsentGuard reads the `req.worker`
 * WorkerAuthGuard attaches). The worker is ALWAYS the bearer's; neither route takes an id.
 *
 * `chat/companion` cannot shadow a `ChatController` route: that controller's paths under `chat/`
 * are `session`, `message`, `session/latest` and `sessions/:sessionId/messages`, none of which
 * starts with `companion`.
 */
@Controller("chat/companion")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class ChatCompanionController {
  constructor(private readonly companion: ChatCompanionService) {}

  /**
   * `{mode:"interview"}` — run the chat tab as today (flag off, profile not confirmed, or a live
   * interview) — or `{mode:"companion", ...recap}`. Never 5xx on a missing fact: the service
   * degrades section by section. `no-store`: the recap is per-worker and changes as they apply.
   */
  @Get()
  @Header("Cache-Control", "no-store")
  open(@CurrentWorker() worker: AuthenticatedWorker, @Ctx() ctx: RequestContext) {
    return this.companion.open(worker.id, ctx);
  }

  /**
   * One answer. **409** when this worker is not (or no longer) in companion mode — the flag was
   * turned off, or a new interview went live — so the app sends that message down today's
   * interview path instead of showing a failed bubble.
   *
   * THE SIGNAL IS THE STATUS CODE. Like every error here, the body goes through the global
   * `AllExceptionsFilter` envelope — `{statusCode: 409, error: {mode: "interview"}, requestId, …}`
   * — so `mode` is under `error`, not at the top level. This is the route's only 409 (the guards
   * answer 401/403/410 and validation 400), so a client routes on `409` alone.
   */
  @Post("message")
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  async message(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(CompanionMessageSchema)) dto: CompanionMessageDto,
    @Ctx() ctx: RequestContext,
  ) {
    const result = await this.companion.message(worker.id, dto, ctx);
    if (result.mode === "interview") throw new ConflictException({ mode: "interview" });
    return result.turn;
  }
}
