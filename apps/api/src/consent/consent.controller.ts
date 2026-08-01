import { Body, Controller, Headers, HttpCode, Ip, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentWorker, WorkerAuthGuard } from "../auth/worker-auth.guard";
import { ConsentService } from "./consent.service";
import { AcceptConsentSchema, type AcceptConsentDto } from "./consent.dto";

@Controller("consent")
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /**
   * Accept consent for the CALLER. Worker-authed: the subject is the session
   * worker, never a body id (see AcceptConsentSchema for why that changed).
   */
  @Post("accept")
  @HttpCode(201)
  @UseGuards(WorkerAuthGuard)
  accept(
    @CurrentWorker() worker: { workerId: string },
    @Body(new ZodValidationPipe(AcceptConsentSchema)) dto: AcceptConsentDto,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    return this.consent.accept(worker.workerId, dto, ip, userAgent, ctx);
  }

  @Post("withdraw")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async withdraw(@CurrentWorker() worker: { workerId: string }, @Ctx() ctx: RequestContext) {
    return this.consent.withdraw(worker.workerId, ctx);
  }
}
