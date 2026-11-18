import { Body, Controller, Get, HttpCode, Put, Query, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import { Ctx, type RequestContext } from "../common/request-context";
import {
  RvmWaiversService,
  type SetWaiverResult,
  type WaiverView,
} from "../rvm-waivers/rvm-waivers.service";
import { campusCall } from "./campus-errors";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusWaiverBodySchema,
  CampusWaiversQuerySchema,
  type CampusWaiverPageSchema,
  type CampusWaiverResponseSchema,
  type CampusWaiverSchema,
} from "./campus-link.contract";
import { CampusIdempotencyKey, CampusZodPipe } from "./campus-request";
import { CampusServiceGuard } from "./campus-service.guard";

type WaiverAnswer = z.input<typeof CampusWaiverSchema>;

/**
 * #2750 item 5 — the placement team's waiver switch, behind the Campus credential (Campus #154
 * item 9 calls it; its screens are #159 items 5 and 6).
 *
 *   PUT waivers   set or clear the waiver of one company or one job (`Idempotency-Key` required,
 *                 like every write; the answer is idempotent by state).
 *   GET waivers   the waivers in force, newest first, each with the opens it paid for.
 *
 * Both answer 404 while the `credit_rules` switch is off everywhere, and 503 with it on and the
 * waiver tables missing. An unknown or barred company, or a job that is not that company's, is the
 * neutral 404.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusWaiversController {
  constructor(private readonly waivers: RvmWaiversService) {}

  @Put("waivers")
  @HttpCode(200)
  async set(
    @Body(new CampusZodPipe(CampusWaiverBodySchema)) body: z.infer<typeof CampusWaiverBodySchema>,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<z.input<typeof CampusWaiverResponseSchema>> {
    const result = await campusCall(() =>
      this.waivers.set(
        {
          scope: body.scope,
          companyId: body.company_id,
          postingId: body.posting_id ?? null,
          active: body.active,
          reason: body.reason,
          actor: { kind: "campus", staffRef: body.staff_ref, staffLabel: body.staff_label },
        },
        ctx,
      ),
    );
    return toResponse(result);
  }

  @Get("waivers")
  async list(
    @Query(new CampusZodPipe(CampusWaiversQuerySchema))
    query: z.infer<typeof CampusWaiversQuerySchema>,
  ): Promise<z.input<typeof CampusWaiverPageSchema>> {
    const page = await campusCall(() =>
      this.waivers.list({
        ...(query.company_id ? { companyId: query.company_id } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
      }),
    );
    return { waivers: page.waivers.map(toWaiver), next_cursor: page.nextCursor };
  }
}

function toResponse(result: SetWaiverResult): z.input<typeof CampusWaiverResponseSchema> {
  return {
    active: result.active,
    changed: result.changed,
    waiver: result.waiver ? toWaiver(result.waiver) : null,
  };
}

/** A waiver as the contract shows it (the admin route answers the same fields). */
export function toWaiver(w: WaiverView): WaiverAnswer {
  return {
    waiver_id: w.waiverId,
    scope: w.scope,
    company_id: w.companyId,
    posting_id: w.postingId,
    active: w.active,
    source: w.source,
    set_by_ref: w.setByRef,
    set_by_label: w.setByLabel,
    reason: w.reason,
    set_at: w.setAt.toISOString(),
    cleared_at: w.clearedAt?.toISOString() ?? null,
    cleared_by_ref: w.clearedByRef,
    cleared_by_label: w.clearedByLabel,
    clear_reason: w.clearReason,
    waived_opens: w.waivedOpens,
  };
}
