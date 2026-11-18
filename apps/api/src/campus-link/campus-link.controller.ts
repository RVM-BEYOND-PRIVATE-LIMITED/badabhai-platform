import { Controller, Delete, Get, Param, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { z } from "zod";
import { Ctx, type RequestContext } from "../common/request-context";
import { CampusServiceGuard } from "./campus-service.guard";
import {
  CAMPUS_CALL_ID_HEADER,
  CAMPUS_LINK_BASE_PATH,
  StudentRefSchema,
  type CampusUnlinkResponseSchema,
} from "./campus-link.contract";
import { CampusIdempotencyKey, CampusZodPipe } from "./campus-request";
import { InstituteLinkService } from "./institute-link.service";

/**
 * BadaBhai Campus's service API (#2752). Every route sits behind `CampusServiceGuard`: its own
 * token, an address allow-list, a per-minute cap and an audit row per call. No worker, company
 * or admin session reaches anything here.
 *
 * The rest of the routes in `campus-link.contract.ts` land here as #2752's later parts and
 * #2746 are built; the contract is published first so Campus can build against it.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusLinkController {
  constructor(private readonly links: InstituteLinkService) {}

  /**
   * Answers only when the flag, the address and the token all pass, so Campus can prove its
   * set-up end to end before any data flows. Read-only: no event; the guard wrote the audit row.
   */
  @Get("ping")
  ping(@Res({ passthrough: true }) res: Response) {
    return { ok: true as const, call_id: String(res.getHeader(CAMPUS_CALL_ID_HEADER)) };
  }

  /**
   * The student withdrew his RVM consent or asked RVM to delete him: unlink him (#2752 item 14).
   * Idempotent by nature, so the key is checked but not stored: an unknown reference, or one
   * already unlinked, answers the same `unlinked` and changes nothing, which also tells Campus
   * nothing about whether BadaBhai ever held him.
   */
  @Delete("students/:student_ref")
  async unlinkStudent(
    @Param("student_ref", new CampusZodPipe(StudentRefSchema)) studentRef: string,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<z.input<typeof CampusUnlinkResponseSchema>> {
    await this.links.unlinkStudent(studentRef, "campus_request", ctx);
    return { student_ref: studentRef, state: "unlinked" };
  }
}
