import { Injectable } from "@nestjs/common";
import { CompanionEditService } from "../companion-edit.service";
import type { CompanionV2Handler, HandlerInput, HandlerResult } from "./handler";

/**
 * "Edit my résumé" (ADR-0046 O4/O5): the edit service snapshots the current values, has the
 * model propose typed rows and returns a card — or one of its fixed lines when nothing can be
 * proposed. The handler is a seam, not logic: everything deterministic lives in the service, and
 * nothing is written until the worker taps Haan.
 */
@Injectable()
export class EditResumeHandler implements CompanionV2Handler {
  constructor(private readonly edits: CompanionEditService) {}

  async handle(input: HandlerInput): Promise<HandlerResult> {
    return this.edits.propose(input.workerId, input.profile, input.text, input.ctx, input.now);
  }
}
