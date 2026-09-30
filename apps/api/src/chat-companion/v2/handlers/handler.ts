import type { WorkerProfile } from "@badabhai/db";
import type { CompanionRecentTurn } from "@badabhai/ai-contracts";
import type { CompanionV2Outcome } from "@badabhai/types";
import type { RequestContext } from "../../../common/request-context";
import type { CompanionTurn } from "../../chat-companion.dto";

/** One classified turn, handed to the handler the registry picked. */
export interface HandlerInput {
  readonly workerId: string;
  readonly profile: WorkerProfile;
  /** The message, ALREADY pseudonymized by the API's gateway (never raw worker text). */
  readonly text: string;
  /**
   * The worker's recent pseudonymized turns, oldest first (≤ `MEMORY_TURNS`), read by the
   * orchestrator for the classifier and passed on so a handler that needs more context — the
   * Phase 3 career answer reads up to six — does not pay a second Redis hop. Empty when the
   * store is unreadable, which every consumer already treats as "no context".
   */
  readonly recentTurns: readonly CompanionRecentTurn[];
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
 * and every other handler serves reviewed copy.
 *
 * "NO WRITES" MEANS NO DOMAIN WRITES — no profile, no résumé, no chat row. Two handlers own
 * state of their own: the edit handler's proposal lives in Redis until the worker taps Haan, and
 * the faltu handler owns its strike/cooldown counters in Redis and emits its strike event. The
 * worker's Haan is still the only path from a handler to a profile write.
 */
export interface CompanionV2Handler {
  handle(input: HandlerInput): Promise<HandlerResult>;
}
