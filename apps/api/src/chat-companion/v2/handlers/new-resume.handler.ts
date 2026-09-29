import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { RESUME_MENU_REDO_LABEL, resolveResumeMenu } from "../../../chat/resume-menu";
import { hasActiveConsent } from "../../../consent/consent-active";
// VALUE import, not `import type`: Nest resolves this constructor parameter by the class token,
// and a type-only import is erased before `emitDecoratorMetadata` runs — the E2E boot caught
// exactly that (NewResumeHandler: dependencies [SERVER_CONFIG, null]) while every unit suite,
// which constructs the handler by hand, stayed green.
import { ConsentRepository } from "../../../consent/consent.repository";
import { SERVER_CONFIG } from "../../../config/config.module";
import { FALLBACK } from "../../companion-replies";
import { taskChips, v2CopyTurn, v2MenuTurn } from "../companion-v2-compose";
import type { CompanionV2Handler, HandlerInput, HandlerResult } from "./handler";

/**
 * "NAYA RESUME" (ADR-0046 P2, branch 4) — the redo flow already exists; this handler only
 * routes a phrasing v1 missed into it.
 *
 * THE TURN IS SERVED VERBATIM, NOT REBUILT. `resolveResumeMenu(RESUME_MENU_REDO_LABEL)` is the
 * exact call the résumé menu makes for its own redo chip, and `v2MenuTurn` shapes it onto the
 * wire exactly as the v1 `menuTurn` does — so "Naya resume banana hai" and a tap on the menu's
 * own redo chip produce the same turn, byte for byte. The options (form / "Chat se resume
 * banayein" / upload) lead into the existing flows; the app already posts
 * `POST /chat/session {redo: true}` from the chat-create option (PR #1769). Nothing here is
 * edited in `resume-menu.ts` — it is imported, per the phase rules.
 *
 * CONSENT IS READ, FAIL CLOSED. Generating a résumé sends the worker's profile to a model, so
 * the worker's latest consent row must be active AND name `resume_generation`; anything else
 * (no row, revoked, a different purpose, a read that throws) serves the v1 fallback line with
 * the task chips instead. This mirrors `ResumeGenerateProcessor`'s own gate — the handler only
 * decides whether to OFFER the flow; the cap and the gate that actually spends are enforced
 * where generation happens, as today.
 */
@Injectable()
export class NewResumeHandler implements CompanionV2Handler {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly consents: ConsentRepository,
  ) {}

  async handle(input: HandlerInput): Promise<HandlerResult> {
    if (!(await hasActiveConsent(this.consents, input.workerId, "resume_generation"))) {
      return { turn: v2CopyTurn(FALLBACK, taskChips(this.config)), outcome: "fallback" };
    }
    return {
      turn: v2MenuTurn(resolveResumeMenu(RESUME_MENU_REDO_LABEL)),
      outcome: "served",
    };
  }
}
