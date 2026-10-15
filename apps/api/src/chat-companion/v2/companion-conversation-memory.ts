import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { CompanionRecentTurn } from "@badabhai/ai-contracts";
import { SERVER_CONFIG } from "../../config/config.module";
import { recentTurnOf } from "../../profiling/free-chat/free-chat-model-calls";
import { companionBrainOn } from "../companion-brain-switch";
import { CompanionHistoryService } from "../companion-history.service";
import { CompanionMemoryStore } from "./companion-memory.store";

/**
 * THE RECENT TURNS A COMPANION MODEL CALL READS (#2297, ADR-0056) — the stored conversation first,
 * the 30-minute Redis memory as the fallback.
 *
 * ON THE BRAIN, the last `CHAT_COMPANION_V2_MEMORY_TURNS` stored lines of the 7-day window that a
 * model call may read (`model_context` — exactly the turns the Redis memory would have kept, so a
 * distress turn or a trash verdict is never among them, ADR-0055 F3/F4). The AI then remembers the
 * conversation across an app restart, not only for 30 minutes. A read that FAILS — the table not
 * migrated yet, the database unwell — falls back to the Redis memory, which is still written.
 *
 * UNDER THE KILL SWITCH the Redis memory alone, exactly as today: the v2 path is unchanged.
 *
 * The appends are the Redis memory's (the stored conversation is written by
 * `CompanionHistoryService`, after the turn). The worker's own name is redacted out of every turn
 * by `FreeChatModelCalls` before a model sees it, as before.
 */
@Injectable()
export class CompanionConversationMemory {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly redis: CompanionMemoryStore,
    private readonly history: CompanionHistoryService,
  ) {}

  /** The worker's recent turns, OLDEST FIRST; `[]` when neither source has any. Never throws. */
  async read(workerId: string, now: Date = new Date()): Promise<CompanionRecentTurn[]> {
    if (companionBrainOn(this.config)) {
      const stored = await this.history.modelLines(
        workerId,
        now,
        this.config.CHAT_COMPANION_V2_MEMORY_TURNS,
      );
      if (stored.ok) {
        // The free chat's ONE definition of a line a model reads (`recentTurnOf`): template
        // tokens stripped, trimmed and clipped to the contract's bound, blank lines dropped. The
        // name is redacted later, by the model call itself.
        return stored.value.flatMap((line): CompanionRecentTurn[] => {
          const role = line.role === "worker" ? "worker" : "assistant";
          const turn = recentTurnOf({ role, text: line.text }, null);
          return turn === null ? [] : [turn];
        });
      }
    }
    return this.redis.read(workerId);
  }

  /** Append one turn to the Redis memory — the fallback source. Best-effort, never throws. */
  async append(workerId: string, turn: CompanionRecentTurn): Promise<void> {
    await this.redis.append(workerId, turn);
  }
}
