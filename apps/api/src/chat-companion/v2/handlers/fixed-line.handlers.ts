import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../../config/config.module";
import { V2_CLARIFY, V2_JOBS_DEFERRED, V2_PHASE_OFF, type CopyPair } from "../../companion-replies";
import { menuForRoad } from "../../companion-resume-menu";
// VALUE import, not `import type`: Nest resolves this constructor parameter by the class token.
import { ResumeService } from "../../../resume/resume.service";
import { editSectionMenu, taskChips, v2CopyTurn, v2MenuTurn } from "../companion-v2-compose";
import type { CompanionV2Handler, HandlerInput, HandlerResult } from "./handler";

/**
 * The three FIXED-LINE handlers (ADR-0046 §2.1 step 7): an intent whose phase is not built yet
 * gets the phase-off line, a jobs question gets its own deferred line (O2), and an unclear turn
 * gets the clarify line — each with the task chips that are actually open. All three are pure:
 * one reviewed pair, one chip row, no reads, no writes.
 */
function fixedLineTurn(
  config: ServerConfig,
  line: CopyPair,
  outcome: HandlerResult["outcome"],
): HandlerResult {
  return { turn: v2CopyTurn(line, taskChips(config)), outcome };
}

@Injectable()
export class JobsDeferredHandler implements CompanionV2Handler {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}
  async handle(_input: HandlerInput): Promise<HandlerResult> {
    return fixedLineTurn(this.config, V2_JOBS_DEFERRED, "phase_off");
  }
}

@Injectable()
export class PhaseOffHandler implements CompanionV2Handler {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}
  async handle(_input: HandlerInput): Promise<HandlerResult> {
    return fixedLineTurn(this.config, V2_PHASE_OFF, "phase_off");
  }
}

/**
 * #2295 (owner ruling 2026-10-15) — a résumé-edit ask on the brain: the résumé's EDIT SECTION MENU,
 * never the AI edit card — except for chat-road profiles, which never see the six sections and
 * get the redo pair (upload + chat) instead. `editAsksGetSectionMenu` decides when it answers.
 */
export class EditSectionMenuHandler implements CompanionV2Handler {
  private readonly logger = new Logger(EditSectionMenuHandler.name);

  constructor(
    // Optional so hand-built constructions (no args) keep working; in production the registry
    // passes the Resume tab's own history read. Absent, only the profile road is checked.
    @Optional() private readonly resumes?: ResumeService,
  ) {}

  async handle(input: HandlerInput): Promise<HandlerResult> {
    const profileSource = (input.profile as { source?: string | null }).source ?? null;
    let resumeSource: string | null = null;
    if (profileSource !== "chat" && this.resumes) {
      try {
        const history = await this.resumes.history(input.workerId, input.now);
        resumeSource = history.items[0]?.source ?? null;
      } catch (err) {
        this.logger.warn(
          `edit menu résumé source unreadable for worker ${input.workerId}; serving the sections (${
            err instanceof Error ? err.name : "UnknownError"
          })`,
        );
        resumeSource = null;
      }
    }
    return {
      turn: v2MenuTurn(menuForRoad(editSectionMenu(), { profileSource, resumeSource })),
      outcome: "served",
    };
  }
}

@Injectable()
export class UnclearHandler implements CompanionV2Handler {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}
  async handle(_input: HandlerInput): Promise<HandlerResult> {
    return fixedLineTurn(this.config, V2_CLARIFY, "clarify");
  }
}
