import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { CompanionV2Intent } from "@badabhai/types";
import { SERVER_CONFIG } from "../../../config/config.module";
import { EditResumeHandler } from "./edit-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./fixed-line.handlers";
import type { CompanionV2Handler } from "./handler";

/**
 * WHICH HANDLER ANSWERS WHICH INTENT (ADR-0046 §2.1 step 7) — one table, no branch anywhere else.
 *
 * THE PHASE FLAGS ARE READ HERE, and only here: `edit_resume` reaches the edit handler only while
 * `CHAT_COMPANION_V2_EDIT_ENABLED` is on; every intent whose phase is not built (jobs by O2's
 * deferral, career/new_resume/faltu until P2/P3) gets the fixed phase-off line. An intent is
 * STILL CLASSIFIED while its phase is off — the metrics must show demand — it just cannot act.
 */
@Injectable()
export class CompanionHandlerRegistry {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly editResume: EditResumeHandler,
    private readonly jobsDeferred: JobsDeferredHandler,
    private readonly phaseOff: PhaseOffHandler,
    private readonly unclear: UnclearHandler,
  ) {}

  resolve(intent: CompanionV2Intent): CompanionV2Handler {
    switch (intent) {
      case "edit_resume":
        return this.config.CHAT_COMPANION_V2_EDIT_ENABLED ? this.editResume : this.phaseOff;
      case "jobs_talk":
        return this.jobsDeferred;
      case "career_talk":
      case "new_resume":
      case "faltu":
        return this.phaseOff;
      case "unclear":
        return this.unclear;
    }
  }
}
