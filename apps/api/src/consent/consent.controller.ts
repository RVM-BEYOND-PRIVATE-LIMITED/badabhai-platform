import { Body, Controller, Get, Header, Headers, HttpCode, Ip, Post, UseGuards } from "@nestjs/common";
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

  /**
   * E0 C-2 — the per-purpose exit from employer contact. NOT `withdraw` above: this keeps
   * the worker's profile, resume and voice purposes, and does not revoke his sessions. The
   * narrowed purposes are DERIVED SERVER-SIDE from his latest consent row; the request
   * carries no body at all, so there is nothing for a client to get wrong.
   *
   * Guarded by `WorkerAuthGuard` alone, exactly like its siblings: the worker is acting on
   * his OWN consent record, which is the record the ConsentGuard itself reads.
   */
  @Post("employer-contact/withdraw")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async withdrawEmployerContact(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    return this.consent.withdrawEmployerContact(worker.id, ip, userAgent, ctx);
  }

  /**
   * #1637 — the caller's LATEST consent row: purposes + revocation only. Worker-self, the
   * same guard posture as the writes above; `no-store` because purposes are worker data.
   *
   * NO ROW IS A REAL ANSWER (`consent_id: null`, `purposes: []`), not a 404 — the
   * stop-employer-contact switch must render "off" on a first launch, not an error.
   */
  @Get("me")
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard)
  async mine(@CurrentWorker() worker: AuthenticatedWorker) {
    return this.consent.getLatestForWorker(worker.id);
  }
}
