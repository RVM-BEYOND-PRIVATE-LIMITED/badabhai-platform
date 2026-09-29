import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../../config/config.module";
import { V2_CLARIFY, V2_JOBS_DEFERRED, V2_PHASE_OFF, type CopyPair } from "../../companion-replies";
import { taskChips, v2CopyTurn } from "../companion-v2-compose";
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

@Injectable()
export class UnclearHandler implements CompanionV2Handler {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}
  async handle(_input: HandlerInput): Promise<HandlerResult> {
    return fixedLineTurn(this.config, V2_CLARIFY, "clarify");
  }
}
