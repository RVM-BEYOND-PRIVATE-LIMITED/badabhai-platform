import { Body, Controller, Put, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import { CampusIdempotencyKey, CampusZodPipe } from "../campus-link/campus-request";
import { CampusServiceGuard } from "../campus-link/campus-service.guard";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusApplicationsCheckBodySchema,
} from "../campus-link/campus-link.contract";
import { FlowCheckEnabledGuard } from "./flow-check.flag";
import { FlowCheckService } from "./flow-check.service";

/**
 * #2890 — `PUT /internal/campus/v1/applications-check`: Campus reports its nightly applications
 * check (Campus #155 item 13), the counts BadaBhai's daily flow check cannot read for itself.
 *
 * Behind the Campus credential (`CampusServiceGuard`: the link switch, the address, the token, the
 * per-minute cap and the call's audit row), then `FLOW_CHECK_ENABLED` (a neutral 404 while off). A
 * PUT because a retry is harmless: the Idempotency-Key Campus sends makes the second call a
 * no-op (`recorded: false`). Stores one counts-only event and nothing else.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard, FlowCheckEnabledGuard)
export class CampusApplicationsCheckController {
  constructor(private readonly flowCheck: FlowCheckService) {}

  @Put("applications-check")
  async report(
    @Body(new CampusZodPipe(CampusApplicationsCheckBodySchema))
    body: z.infer<typeof CampusApplicationsCheckBodySchema>,
    @CampusIdempotencyKey() idempotencyKey: string,
  ): Promise<{ recorded: boolean }> {
    return this.flowCheck.recordCampusReport(body, idempotencyKey);
  }
}
