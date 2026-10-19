import { Inject, Injectable, Optional } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { CompanionV2Intent } from "@badabhai/types";
import { SERVER_CONFIG } from "../../../config/config.module";
import { editAsksGetSectionMenu } from "../../companion-brain-switch";
// VALUE import, not `import type`: Nest resolves this constructor parameter by the class token.
import { ResumeService } from "../../../resume/resume.service";
import { CareerTalkHandler } from "./career-talk.handler";
import { EditResumeHandler } from "./edit-resume.handler";
import { FaltuHandler } from "./faltu.handler";
import {
  EditSectionMenuHandler,
  JobsDeferredHandler,
  PhaseOffHandler,
  UnclearHandler,
} from "./fixed-line.handlers";
import { NewResumeHandler } from "./new-resume.handler";
import type { CompanionV2Handler } from "./handler";

/**
 * WHICH HANDLER ANSWERS WHICH INTENT (ADR-0046 §2.1 step 7) — one table, no branch anywhere else.
 *
 * THE PHASE FLAGS ARE READ HERE, and only here: `edit_resume` reaches the edit handler only while
 * `CHAT_COMPANION_V2_EDIT_ENABLED` is on; `new_resume` reaches the redo flow only while
 * `CHAT_COMPANION_V2_NEW_RESUME_ENABLED` is on; `faltu` reaches the strike counter only while
 * `CHAT_COMPANION_V2_FALTU_ENABLED` is on; `career_talk` reaches the model only while
 * `CHAT_COMPANION_V2_CAREER_ENABLED` is on; every intent whose phase is not built (jobs by O2's
 * deferral) gets the fixed phase-off line. An intent is STILL CLASSIFIED while its phase is off —
 * the metrics must show demand — it just cannot act.
 *
 * #2295 (owner ruling 2026-10-15): while `editAsksGetSectionMenu` (the free-chat brain is on),
 * `edit_resume` gets the résumé's edit section menu whatever the edit phase flag says — never the
 * AI edit card. Under the kill switch the table is as above.
 */
@Injectable()
export class CompanionHandlerRegistry {
  private readonly editSectionMenu: EditSectionMenuHandler;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly editResume: EditResumeHandler,
    private readonly newResume: NewResumeHandler,
    private readonly faltu: FaltuHandler,
    private readonly careerTalk: CareerTalkHandler,
    private readonly jobsDeferred: JobsDeferredHandler,
    private readonly phaseOff: PhaseOffHandler,
    private readonly unclear: UnclearHandler,
    // Optional: the résumé read behind the chat-road menu rule. Hand-built registries in unit
    // suites omit it and check only the profile road.
    @Optional() resumes?: ResumeService,
  ) {
    this.editSectionMenu = new EditSectionMenuHandler(resumes);
  }

  resolve(intent: CompanionV2Intent): CompanionV2Handler {
    switch (intent) {
      case "edit_resume":
        if (editAsksGetSectionMenu(this.config)) return this.editSectionMenu;
        return this.config.CHAT_COMPANION_V2_EDIT_ENABLED ? this.editResume : this.phaseOff;
      case "new_resume":
        return this.config.CHAT_COMPANION_V2_NEW_RESUME_ENABLED ? this.newResume : this.phaseOff;
      case "faltu":
        return this.config.CHAT_COMPANION_V2_FALTU_ENABLED ? this.faltu : this.phaseOff;
      case "career_talk":
        return this.config.CHAT_COMPANION_V2_CAREER_ENABLED ? this.careerTalk : this.phaseOff;
      case "jobs_talk":
        return this.jobsDeferred;
      case "unclear":
        return this.unclear;
    }
  }
}
