import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { CampusServiceGuard } from "./campus-service.guard";
import { CAMPUS_CALL_ID_HEADER, CAMPUS_LINK_BASE_PATH } from "./campus-link.contract";

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
  /**
   * Answers only when the flag, the address and the token all pass, so Campus can prove its
   * set-up end to end before any data flows. Read-only: no event; the guard wrote the audit row.
   */
  @Get("ping")
  ping(@Res({ passthrough: true }) res: Response) {
    return { ok: true as const, call_id: String(res.getHeader(CAMPUS_CALL_ID_HEADER)) };
  }
}
