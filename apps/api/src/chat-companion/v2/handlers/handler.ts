import type { WorkerProfile } from "@badabhai/db";
import type { CompanionRecentTurn } from "@badabhai/ai-contracts";
import type { CompanionV2Outcome } from "@badabhai/types";
import type { RequestContext } from "../../../common/request-context";
import type { CompanionTurn } from "../../chat-companion.dto";

/** One classified turn, handed to the handler the registry picked. */
export interface HandlerInput {
  readonly workerId: string;
  readonly profile: WorkerProfile;
  /**
   * The message, pseudonymized by the API's gateway while `AI_RAW_PII_ENABLED` is off and the
   * worker's RAW words while it is on (the orchestrator's `promptTextOf`) — or, for a task-chip
   * tap, the chip's server-authored label (a constant, never the posted bytes). So a handler must
   * treat it as raw either way: it may go to a model call, and it is NEVER logged, evented or
   * persisted by a handler.
   */
  readonly text: string;
  /**
   * The worker's recent turns, oldest first (≤ `MEMORY_TURNS`) — pseudonymized, or raw for the
   * turns stored while `AI_RAW_PII_ENABLED` was on; the same never-log rule as `text` applies.
   * Read by the orchestrator for the classifier and passed on so a handler that needs more
   * context — the Phase 3 career answer sends the newest six, whatever the knob — does not pay a
   * second Redis hop. Empty when the store is unreadable, which every consumer already treats as
   * "no context".
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
