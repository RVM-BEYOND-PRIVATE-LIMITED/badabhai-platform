import { Body, Controller, Headers, HttpCode, Ip, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  CurrentWorker,
  WorkerAuthGuard,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentService } from "./consent.service";
import { AcceptConsentSchema, type AcceptConsentDto } from "./consent.dto";

@Controller("consent")
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /**
   * Accept consent for the CALLER. Worker-authed: the subject is the session
   * worker, never a body id (see AcceptConsentSchema for why that changed).
   *
   * THE PARAMETER TYPE IS {@link AuthenticatedWorker}, NOT A HAND-WRITTEN SHAPE.
   * Both handlers here used to annotate `{ workerId: string }` and read
   * `worker.workerId` — but `CurrentWorker` returns `{ id, sid, deviceId? }`, so
   * that read was `undefined` at runtime and BOTH ROUTES 500'd for every caller
   * (`select … from workers where id = $1` with an empty param). A hand-written
   * structural type accepted it silently; importing the real one is what makes
   * the compiler catch the next occurrence.
   */
  @Post("accept")
  @HttpCode(201)
  @UseGuards(WorkerAuthGuard)
  accept(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(AcceptConsentSchema)) dto: AcceptConsentDto,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    return this.consent.accept(worker.id, dto, ip, userAgent, ctx);
  }

  @Post("withdraw")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async withdraw(@CurrentWorker() worker: AuthenticatedWorker, @Ctx() ctx: RequestContext) {
    return this.consent.withdraw(worker.id, ctx);
  }
}
