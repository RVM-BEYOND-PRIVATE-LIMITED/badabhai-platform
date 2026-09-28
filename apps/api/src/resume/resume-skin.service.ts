import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import type { PayloadInputOf } from "@badabhai/event-schema";
import { DEFAULT_RESUME_SKIN, RESUME_SKINS, type ResumeSkin } from "@badabhai/types";

import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { ResumeRerenderService } from "./resume-rerender.service";
import { ResumeSkinReader } from "./resume-skin.reader";
import { ResumeSkinRepository } from "./resume-skin.repository";
import type { ResumeSkinStateResponse, SetResumeSkinResponse } from "./resume-skin.dto";

/**
 * RÉSUMÉ SKINS (#1801; owner ruling 2026-09-28, "Plumbing, Neela only") — the worker's per-worker
 * colour preference for their `bb_trade` sheet. Business rules only: the rows are
 * {@link ResumeSkinRepository}'s, what a row MEANS is {@link ResumeSkinReader}'s (shared with the
 * render worker), and how a skin reaches the page is `resume-skins.ts`.
 *
 * OFF MEANS ABSENT. With `RESUME_SKINS_ENABLED` off every method answers as if skins did not
 * exist — the state says `enabled: false`, a choice is a 404 (the tier endpoints' precedent) — and
 * NO query touches migration 0128's table. That is what makes 0128 apply-before-flag-on rather than
 * apply-before-deploy.
 */
@Injectable()
export class ResumeSkinService {
  private readonly logger = new Logger(ResumeSkinService.name);

  constructor(
    private readonly repo: ResumeSkinRepository,
    private readonly reader: ResumeSkinReader,
    private readonly events: EventsService,
    private readonly rerender: ResumeRerenderService,
  ) {}

  /** `GET /resume/skin` — whether skins are on, the skin their sheet prints in, and the choices. */
  async state(workerId: string): Promise<ResumeSkinStateResponse> {
    const skin = await this.reader.forWorker(workerId);
    if (skin === null) return { enabled: false, skin: null, skins: [] };
    return { enabled: true, skin, skins: [...RESUME_SKINS] };
  }

  /**
   * `PUT /resume/skin` — the worker confirmed a skin.
   *
   * PERSISTS ONLY A REAL CHANGE. The skin they already hold (a retried tap on a flaky link) is a 200
   * with `change: "unchanged"`: nothing written, no event, no re-render. A worker with no row who
   * picks Neela IS a change — their first explicit choice — reported with `previous_skin: null`.
   *
   * ONE TRANSACTION for the write and `resume.skin_changed` (the must-fix H3 seam): an emit failure
   * rolls the preference back, so the spine and the table can never disagree. The row is locked
   * for the duration, so two concurrent changes serialise and each reports the skin it replaced;
   * two concurrent FIRST choices cannot both insert: a loser that asked for the winner's skin is
   * the same no-op as a retry, and one that asked for a different skin is a 409 to re-fetch.
   *
   * THEN, OUTSIDE THE TRANSACTION, the worker's latest résumé is queued for a cosmetic re-render —
   * only when one exists AND the skin it prints in actually changed. Best-effort: the choice is
   * already committed and must not fail on the queue.
   */
  async set(
    workerId: string,
    skin: ResumeSkin,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<SetResumeSkinResponse> {
    if (!this.reader.enabled) throw new NotFoundException("résumé skins are not enabled");

    const outcome = await this.repo.withTransaction(async (tx) => {
      const held = await this.repo.lockSkin(workerId, tx);
      if (held === skin) return { previous: skin, changed: false } as const;
      const previous = this.reader.known(held);
      if (held === null) {
        const inserted = await this.repo.insertSkin(workerId, skin, now, tx);
        if (!inserted) {
          // A concurrent FIRST choice won the insert. Read what it committed: the SAME skin is the
          // double-tap on a flaky link that the no-op above exists for, so it answers the same
          // way; only a DIFFERENT skin is a real race the caller must re-fetch.
          const winner = await this.repo.lockSkin(workerId, tx);
          if (winner === skin) return { previous: skin, changed: false } as const;
          throw new ConflictException("résumé skin changed concurrently; fetch it and retry");
        }
      } else {
        await this.repo.updateSkin(workerId, skin, now, tx);
      }
      await this.events.emit({
        event_name: "resume.skin_changed",
        actor: { actor_type: "worker", actor_id: workerId },
        // A per-worker preference, not a property of one generated résumé.
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          skin,
          previous_skin: previous,
        } satisfies PayloadInputOf<"resume.skin_changed">,
        // NO idempotency key, deliberately. Exactly-once comes from the transaction (the event
        // commits iff the change does) and from the no-op above (a retry of a committed change
        // finds the skin already held and writes nothing). A transition key such as `from:to`
        // would be WRONG here: skins may go A → B → A → B, and the second A → B is a real change
        // that such a key would silently dedupe.
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
      return { previous, changed: true } as const;
    });

    if (!outcome.changed) return { skin, previous_skin: outcome.previous, change: "unchanged" };

    this.logger.log(
      `resume skin changed for worker ${workerId} (${outcome.previous ?? "none"} -> ${skin})`,
    );
    // RE-RENDER ONLY IF THE PAGE CHANGES. No row (or a stored skin this build does not know)
    // already prints in the house default, so a first choice OF that default changes no byte —
    // the same "only when the PDF would change" rule every other presentation re-render follows.
    // With Neela the only skin today, this never fires; it will with the second skin.
    if ((outcome.previous ?? DEFAULT_RESUME_SKIN) !== skin) {
      await this.rerender.enqueueLatest(workerId, ctx);
    }
    return { skin, previous_skin: outcome.previous, change: "changed" };
  }
}
