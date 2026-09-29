import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../../config/config.module";
import { EventsService } from "../../../events/events.service";
import { V2_FALTU_REDIRECT } from "../../companion-replies";
import { taskChips, v2CooldownTurn, v2CopyTurn } from "../companion-v2-compose";
import { FaltuStore } from "../faltu.store";
import type { CompanionV2Handler, HandlerInput, HandlerResult } from "./handler";

/**
 * FALTU (ADR-0046 P2, O11) — trash talk, flirting, jokes, random topics. The handler is reached
 * two ways and treats them the same: the ABUSE LEXICON flagged the message locally (no model
 * call at all), or the classifier returned the `faltu` intent. Either way:
 *
 *   strike 1–2   the redirect line + the open chips. The message is never echoed, quoted or
 *                summarised — the reply talks about the tab, not about what was said.
 *   strike >= N  the cool-down flag is set (`FALTU_COOLDOWN_MINUTES`) and the cool-down line is
 *                served with `cooldown_until`, so the app can disable the composer (F1). Free
 *                text is then blocked at the service's gate; chips still pass, so the worker
 *                can always reach the résumé and jobs.
 *
 * FAIL OPEN ON REDIS, deliberately and only here: a counter that cannot be written counts NO
 * strike and the redirect is still served; a cool-down flag that cannot be written does not
 * exist. A Redis outage must never silence a worker. The event is emitted with the count that
 * was actually counted — a refused counter emits NOTHING rather than a fabricated zero.
 *
 * THE EVENT IS THE ONLY TRACE. `chat.companion_faltu_strike` carries the count and whether this
 * strike started the cool-down; the message itself reaches no event, no log line and no memory
 * (the orchestrator passes no memory pair on this path).
 */
@Injectable()
export class FaltuHandler implements CompanionV2Handler {
  private readonly logger = new Logger(FaltuHandler.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly faltu: FaltuStore,
    private readonly events: EventsService,
  ) {}

  async handle(input: HandlerInput): Promise<HandlerResult> {
    const day = input.now.toISOString().slice(0, 10);
    const count = await this.faltu.countStrike(input.workerId, day);

    if (count === null) {
      // The counter is unreachable: no strike counted, no cool-down, and no event — there is
      // no number to report. The worker still gets the redirect and the chips.
      return this.redirect();
    }

    if (count >= this.config.CHAT_COMPANION_V2_FALTU_STRIKES) {
      const until = await this.faltu.startCooldown(input.workerId, input.now);
      await this.emitStrike(input, count, until !== null);
      return until === null ? this.redirect() : this.cooldown(until);
    }

    await this.emitStrike(input, count, false);
    return this.redirect();
  }

  private redirect(): HandlerResult {
    return { turn: v2CopyTurn(V2_FALTU_REDIRECT, taskChips(this.config)), outcome: "served" };
  }

  private cooldown(until: string): HandlerResult {
    return { turn: v2CooldownTurn(until, taskChips(this.config)), outcome: "cooldown" };
  }

  private async emitStrike(
    input: HandlerInput,
    strikeCount: number,
    cooldownStarted: boolean,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.companion_faltu_strike",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "worker", subject_id: input.workerId },
        payload: { strike_count: strikeCount, cooldown_started: cooldownStarted },
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });
    } catch (err) {
      // Best-effort, like every companion event: a failed audit write never costs the worker
      // their answer. Ids and the error CLASS only — never the message.
      this.logger.error(
        `chat.companion_faltu_strike not recorded for worker ${input.workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
