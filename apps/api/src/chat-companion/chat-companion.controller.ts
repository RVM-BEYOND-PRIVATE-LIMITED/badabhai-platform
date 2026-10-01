import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { uuidSchema } from "@badabhai/validators";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ChatCompanionService } from "./chat-companion.service";
import {
  CancelEditSchema,
  CompanionMessageSchema,
  ConfirmEditSchema,
  type CancelEditDto,
  type CompanionMessageDto,
  type ConfirmEditDto,
} from "./chat-companion.dto";

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

  /**
   * The worker tapped **Haan** on an edit card (ADR-0046 O4/O6). HTTP only.
   *
   * THE STATUS CODES ARE THE CONTRACT (§5.2):
   *   - 200 — the ticked rows applied, and the answer is a normal turn; or NOTHING was written
   *     (rolled back whole), and the answer is the fallback turn carrying the SAME
   *     `edit_proposal`, so the card stays and Haan can be tapped again;
   *   - 404 — unknown, expired, already-confirmed (or being confirmed by another request), or
   *     ANOTHER WORKER'S proposal (the store is keyed by the bearer's worker id, so there is no
   *     cross-worker oracle);
   *   - 409 `{mode:"interview"}` — the worker is not in companion mode any more, same as message;
   *   - 409 `{reason:"stale", turn}` — the profile moved under the card; NOTHING was written and
   *     the app must drop the card. `turn` (additive) is the reviewed V2_EDIT_STALE line with its
   *     read-aloud twin, for the app to show in place of a line of its own.
   */
  @Post("edits/:proposalId/confirm")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async confirmEdit(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("proposalId", new ZodValidationPipe(uuidSchema)) proposalId: string,
    @Body(new ZodValidationPipe(ConfirmEditSchema)) dto: ConfirmEditDto,
    @Ctx() ctx: RequestContext,
  ) {
    const result = await this.companion.confirmEdit(worker.id, proposalId, dto, ctx);
    if (result.mode === "interview") throw new ConflictException({ mode: "interview" });
    if (result.mode === "stale") throw new ConflictException({ reason: "stale", turn: result.turn });
    if (result.mode === "not_found") throw new NotFoundException();
    return result.turn;
  }

  /** The worker tapped **Nahi**: the card is dropped and nothing is written. 404 as above. */
  @Post("edits/:proposalId/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async cancelEdit(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("proposalId", new ZodValidationPipe(uuidSchema)) proposalId: string,
    @Body(new ZodValidationPipe(CancelEditSchema)) _dto: CancelEditDto,
    @Ctx() ctx: RequestContext,
  ) {
    const result = await this.companion.cancelEdit(worker.id, proposalId, ctx);
    if (result.mode === "interview") throw new ConflictException({ mode: "interview" });
    if (result.mode === "not_found") throw new NotFoundException();
    return result.turn;
  }
}
