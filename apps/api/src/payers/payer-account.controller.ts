import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "./payer-auth.guard";
import { PayerAccountService } from "./payer-account.service";
import { PayerAccountDeletionService } from "./payer-account-deletion.service";
import {
  PayerUpdateSchema,
  type PayerDeleteImmediateResponse,
  type PayerMeDto,
  type PayerUpdateDto,
} from "./payer-account.dto";

/**
 * The FIRST payer-authenticated route group (ADR-0019 LC-1 / TD33, slice 1).
 *
 * Every route here is reachable by EXACTLY ONE principal class — the payer session
 * via {@link PayerAuthGuard} (distinct from the worker session and the ops
 * `InternalServiceGuard`). The authenticated `payerId` is taken ONLY from the guard
 * principal (`@CurrentPayer`); it is NEVER read from the body/param/query, so no
 * payer can reach another payer's account (horizontal-authz, Decision C — proven by
 * `payer-account.controller.test.ts`).
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerAccountController {
  private readonly logger = new Logger(PayerAccountController.name);

  constructor(
    private readonly account: PayerAccountService,
    private readonly deletion: PayerAccountDeletionService = {} as PayerAccountDeletionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig = {
      TEST_IMMEDIATE_DELETE_ENABLED: false,
    } as ServerConfig,
  ) {}

  /**
   * The authenticated payer's OWN account (incl. their own email + masked phone). No other
   * payer is reachable. `no-store` so the response — which carries the payer's own contact —
   * is never written to a shared/proxy cache.
   */
  @Get("me")
  @Header("Cache-Control", "no-store")
  me(@CurrentPayer() payer: AuthenticatedPayer): Promise<PayerMeDto> {
    return this.account.getOwnAccount(payer.id);
  }

  /**
   * Self-edit the authenticated payer's OWN org display name and/or contact phone (PROF-3).
   * Email/role/status are IMMUTABLE — they are not fields on {@link PayerUpdateSchema}, and
   * its `.strict()` rejects them (and a body `payer_id`, and any unknown key) with a 400; an
   * empty body is also a 400 ("nothing to update"). The id is the GUARD principal ONLY (never
   * the body), so no payer can edit another's account. `no-store` for the same reason as `me`
   * — the response carries the payer's own contact. Returns the updated {@link PayerMeDto}.
   */
  @Patch("me")
  @Header("Cache-Control", "no-store")
  updateMe(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Body(new ZodValidationPipe(PayerUpdateSchema)) patch: PayerUpdateDto,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerMeDto> {
    return this.account.updateOwnAccount(payer.id, patch, ctx);
  }

  /**
   * QA-ONLY immediate hard-delete seam (the payer mirror of
   * `POST /auth/account/delete/immediate`). Erases the CALLING payer's account
   * RIGHT NOW — no grace — so QA can reproduce a real payer deletion WITHOUT a
   * DBA. Identity is ALWAYS the guard's `payer.id`, never a body (no IDOR).
   *
   * GATED, DEFAULT OFF: while `TEST_IMMEDIATE_DELETE_ENABLED` is off this route
   * answers a NEUTRAL 404 (behaves as if it does not exist). The check runs
   * INSIDE the handler (after `PayerAuthGuard`), so an unauthenticated token is
   * still the guard's normal 401 — only an AUTHED caller on a DISABLED build
   * sees the 404. Same `assertAuthConfig` boot-refusal posture as the worker
   * seam: arming the flag outside development/test/staging refuses to boot.
   *
   * A payer whose solo org has NO other members gets the org removed with them;
   * a payer owning a SHARED org gets a 409 (a test tap must never destroy a
   * team's org — remove or transfer it first). Billing rails are PII-free
   * opaque refs with no FK and intentionally SURVIVE (B2). Idempotent: an
   * already-gone payer is still `{ ok: true }`.
   */
  @Post("me/delete/immediate")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async deleteImmediate(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerDeleteImmediateResponse> {
    if (!this.config.TEST_IMMEDIATE_DELETE_ENABLED) throw new NotFoundException("Not found");
    await this.deletion.execute(payer.id, ctx);
    this.logger.warn(`QA immediate delete payer=${payer.id.slice(0, 8)} via POST /payer/me/delete/immediate`);
    return { ok: true };
  }
}
