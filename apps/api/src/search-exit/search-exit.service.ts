import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database, WorkerSearchExitVia } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";

import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import type { SearchVisibilityResponse } from "./search-exit.dto";
import { searchExitEnabled } from "./search-exit.flag";
import { PG_UNDEFINED_TABLE } from "./search-exit-missing-table";
import { SearchExitRepository, type StoredSearchExit } from "./search-exit.repository";

/** The reply for a stored exit (or none). A fresh object per reply. */
const replyFor = (exit: StoredSearchExit | null): SearchVisibilityResponse =>
  exit === null
    ? { visible: true, hidden_since: null }
    : { visible: false, hidden_since: exit.hiddenAt.toISOString() };

/**
 * LEAVE COMPANY SEARCH (#2753 item 6) — whether companies can find one worker. Business rules only:
 * the row is {@link SearchExitRepository}'s; who the search and the unlock path refuse is
 * `CandidateSearchRepository`'s pool predicate and `searchExitRefuses` (search-exit-gate.ts).
 *
 * WHAT "OUT OF SEARCH" MEANS. A row in `worker_search_exits`: he is absent from every company's
 * candidate search (and its city facet, and the admin card read, which then says "not in the
 * pool"), and a company he did not apply to cannot open his contact from an id it kept. A company he
 * applied to still opens him; a company already holding an open contact keeps it.
 *
 * WHAT IT DOES NOT TOUCH. His consent: no `worker_consents` row is written, revoked or read here, so
 * withdrawing consent stays the stronger exit and coming back needs no new consent. And everything
 * that is his side of the platform: his own job feed, applying, chat, and every company's applicant
 * list for a job he applied to.
 *
 * THE SWITCH FIRST, ALWAYS. With `SEARCH_EXIT_ENABLED` off every method is a 404 that reads and
 * writes nothing (the route guard 404s even earlier, before auth). That is what makes migration
 * 0168 apply-before-the-switch.
 *
 * ON BEFORE 0168: 503, NOT 500, AND NOT FAIL OPEN. The two routes are the WRITE path of this table
 * (the GET is the screen the switch is on), so with the table missing (42P01) there is nothing
 * honest to answer: "visible" would show a switch that cannot be flipped, and a PUT cannot store a
 * leave. They answer 503 Service Unavailable and write nothing (the transaction rolls back).
 * The READERS fail open instead (search and unlock: nobody can be hidden without the table). The
 * log line carries the worker id and the SQLSTATE only; any other error propagates.
 *
 * REUSABLE. {@link setVisibility} takes the `via`, so the later monthly check ("not now") calls it
 * with `monthly_check` and inherits the same no-op and event rules.
 */
@Injectable()
export class SearchExitService {
  private readonly logger = new Logger(SearchExitService.name);

  constructor(
    private readonly repo: SearchExitRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** `GET /workers/me/search-visibility`. A read: no event. */
  async visibilityFor(workerId: string): Promise<SearchVisibilityResponse> {
    this.assertOn();
    try {
      return replyFor(await this.repo.find(workerId));
    } catch (err) {
      throw this.unavailableIfMissing(err, "read", workerId);
    }
  }

  /**
   * Take him out (`visible: false`) or bring him back (`visible: true`), and answer the visibility
   * now in force.
   *
   * PERSISTS ONLY A REAL CHANGE. Leaving while out keeps the FIRST `hidden_at` (and its `via`) and
   * emits nothing; coming back while in emits nothing. So a retried PUT is a 200 with the same
   * body, and needs no Idempotency-Key (the work-preferences PUT precedent).
   *
   * ONE TRANSACTION for the row and `worker.search_visibility_changed`: an emit failure rolls the
   * change back, so the spine and the table never disagree. Two concurrent "leave"s cannot both
   * insert (the primary key): the loser re-reads the winner's row in the same transaction.
   */
  async setVisibility(
    workerId: string,
    visible: boolean,
    via: WorkerSearchExitVia,
    ctx: RequestContext,
  ): Promise<SearchVisibilityResponse> {
    this.assertOn();
    const { reply, changed } = await this.write(workerId, async (tx) => {
      if (visible) {
        const removed = await this.repo.remove(workerId, tx);
        if (removed) await this.emitChanged(workerId, true, via, ctx, tx);
        return { reply: replyFor(null), changed: removed };
      }
      const inserted = await this.repo.insert(workerId, via, tx);
      if (inserted === null) {
        // Already out: the first exit stands. Read on the same transaction (the row is committed or
        // ours to wait on), never the global pool.
        return { reply: replyFor(await this.repo.find(workerId, tx)), changed: false };
      }
      await this.emitChanged(workerId, false, via, ctx, tx);
      return { reply: replyFor(inserted), changed: true };
    });
    if (changed) {
      this.logger.log(
        `search visibility changed (worker=${workerId} visible=${visible} via=${via})`,
      );
    }
    return reply;
  }

  private assertOn(): void {
    if (!searchExitEnabled(this.config)) throw new NotFoundException();
  }

  /** One write transaction; a missing table (0168 not applied) is a 503, rolled back. */
  private async write<T>(workerId: string, work: (tx: Database) => Promise<T>): Promise<T> {
    try {
      return await this.repo.withTransaction(work);
    } catch (err) {
      throw this.unavailableIfMissing(err, "write", workerId);
    }
  }

  /** A 503 (logged: the worker id and the SQLSTATE) for 42P01; any other error unchanged. */
  private unavailableIfMissing(err: unknown, op: "read" | "write", workerId: string): unknown {
    if (sqlStateOf(err) !== PG_UNDEFINED_TABLE) return err;
    this.logger.warn(
      `search visibility ${op} unavailable: worker_search_exits is missing ` +
        `(worker=${workerId} sqlstate=${PG_UNDEFINED_TABLE})`,
    );
    return new ServiceUnavailableException();
  }

  private async emitChanged(
    workerId: string,
    visible: boolean,
    via: WorkerSearchExitVia,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    await this.events.emit({
      event_name: "worker.search_visibility_changed",
      // He acts on himself, on either surface: the monthly check is his own answer too.
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        visible,
        via,
      } satisfies PayloadInputOf<"worker.search_visibility_changed">,
      // NO idempotency key, deliberately (the display-prefs precedent). Exactly-once comes from the
      // transaction (the event commits iff the change does) and from the no-op above. A key on the
      // worker and the value would be WRONG: out → in → out is two real exits.
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }
}
