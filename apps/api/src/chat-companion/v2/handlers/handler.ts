import type { WorkerProfile } from "@badabhai/db";
import type { CompanionV2Outcome } from "@badabhai/types";
import type { RequestContext } from "../../../common/request-context";
import type { CompanionTurn } from "../../chat-companion.dto";

/** One classified turn, handed to the handler the registry picked. */
export interface HandlerInput {
  readonly workerId: string;
  readonly profile: WorkerProfile;
  /** The message, ALREADY pseudonymized by the API's gateway (never raw worker text). */
  readonly text: string;
  readonly ctx: RequestContext;
  readonly now: Date;
}

/** A handler's product: the turn to serve, and the closed outcome the v2 event records. */
export interface HandlerResult {
  readonly turn: CompanionTurn;
  readonly outcome: CompanionV2Outcome;
}

/**
 * One intent's answer. Handlers are deterministic and never call a model themselves: the edit
 * handler delegates to the edit service (whose model call is the SECOND step of an edit turn),
 * and every other handler serves reviewed copy. A handler NEVER writes anything.
 */
export interface CompanionV2Handler {
  handle(input: HandlerInput): Promise<HandlerResult>;
}
