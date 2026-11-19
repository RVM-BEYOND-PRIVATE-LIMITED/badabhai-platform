import {
  type CanActivate,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { SERVER_CONFIG } from "../config/config.module";
import { SyntheticRunService } from "./synthetic-run.service";

/** `FLOW_SYNTHETIC_RUN_ENABLED` as a route gate: a neutral 404 while off, before anything runs. */
@Injectable()
export class SyntheticRunEnabledGuard implements CanActivate {
  constructor(
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "FLOW_SYNTHETIC_RUN_ENABLED">,
  ) {}

  canActivate(): boolean {
    if (this.config?.FLOW_SYNTHETIC_RUN_ENABLED !== true) throw new NotFoundException();
    return true;
  }
}

/**
 * #2967 — `POST /flow-check/synthetic-run`: an operator's run-now of the daily synthetic run (after
 * a deploy, or to confirm a fix), and the CI e2e suite's trigger. Behind the shared ops token FIRST
 * (401 without it, the prod canary probes that), then the switch (404 while off). The walk is the
 * scheduled one: one rolled-back transaction, nothing kept but its counts-only record, so a repeat
 * is harmless. Answers the step it reached and its closed failure code.
 */
@Controller("flow-check")
@UseGuards(InternalServiceGuard, SyntheticRunEnabledGuard)
export class SyntheticRunController {
  constructor(private readonly synthetic: SyntheticRunService) {}

  @Post("synthetic-run")
  @HttpCode(200)
  async runNow() {
    return this.synthetic.runAndRecord(new Date(), "ops");
  }
}
