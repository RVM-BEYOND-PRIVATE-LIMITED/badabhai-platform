import { Injectable } from "@nestjs/common";
import { interleaveMaxPerCompany } from "@badabhai/match-engine";
import { matchSkillLabel } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository, type MatchFeedFilters } from "./match-feed.repository";

/**
 * One V1 feed card.
 *
 * SUPERSET OF THE SHIPPED CONTRACT. `GET /feed` keeps its route, its guards, its
 * response envelope (`{ jobs: [...] }`) and its Flutter client, so every field the
 * legacy card carried is present with the same key and the same meaning. `via_related`
 * and `matched_skill_label` are ADDITIVE (a client that ignores them is unaffected).
 *
 * `job_id` CARRIES A `job_postings.id` HERE, not a `jobs.id`. That is the cutover: V1
 * serves the posting entity. The key keeps its name because renaming it would break the
 * shipped Flutter client for zero behavioural gain — the client treats it as an opaque
 * handle and posts it straight back to `/applications/:jobId/apply`, which resolves it
 * against `job_postings` under the same flag.
 */
export interface MatchFeedItem {
  job_id: string;
  trade_key: string;
  title: string;
  city: string;
  area: string | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  pay_min: number | null;
  pay_max: number | null;
  shift: string | null;
  rank: number;
  /** E18 — he was reached through a RELATED skill, not the posted one. */
  via_related: boolean;
  /** E18 — the skill that earned the match, for the badge. */
  matched_skill_label: string | null;
}

/**
 * MOMENT ④ — "Worker opens feed. No scoring."
 *
 * The whole surface behind `MATCH_V1_ENABLED`. It is a source swap, not a new endpoint:
 * `ApplicationsService.getFeed` chooses this or the legacy `jobs` read, and everything
 * outside — route, guards, envelope, client — is untouched.
 *
 * PII: ADR-0036 leaves exactly ONE open product/privacy question — whether `org_label`
 * may render on the worker card, given that max-2-consecutive-cards-per-company implies
 * company identity is visible. It needs a security-review sign-off, so this change does
 * not take the decision: the repository does not even SELECT `org_label`, `MatchFeedItem`
 * has no org field, and `payerKey` (an opaque `payer_id`/`created_by`) is used solely as
 * the interleave key and never leaves this service. The max-2 rule is enforced without
 * ever telling the worker WHICH company.
 */
@Injectable()
export class MatchFeedService {
  constructor(
    private readonly repo: MatchFeedRepository,
    private readonly config: MatchConfigService,
    private readonly events: EventsService,
  ) {}

  /**
   * Serve the feed and emit one `feed.shown_v2` per card.
   *
   * OVERFETCH THEN INTERLEAVE. `interleaveMaxPerCompany` is a permutation — it never
   * drops a row — so applying it to exactly `limit` rows would only shuffle within the
   * page and one company could still own the whole page. Fetching ~3× and truncating
   * after the interleave is what actually gives the rule material to work with. The
   * multiplier is capped so a large `limit` cannot turn one feed request into an
   * unbounded scan.
   */
  async getFeed(
    workerId: string,
    limit: number,
    filters: MatchFeedFilters,
    ctx: RequestContext,
  ): Promise<{ jobs: MatchFeedItem[] }> {
    const cfg = await this.config.get();

    const overfetch = Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
    const candidates = await this.repo.listFeed(workerId, overfetch, filters);

    // E14 — at most `max_consecutive_same_company` cards in a row from one company.
    // Keyed on `payer_id`, falling back to `created_by` for ops-created postings, so an
    // ops actor bulk-loading a register does not flood one worker's feed either.
    const interleaved = interleaveMaxPerCompany(candidates, cfg.maxConsecutiveSameCompany);
    const page = interleaved.slice(0, limit);

    const items: MatchFeedItem[] = page.map((row, index) => ({
      job_id: row.jobPostingId,
      // The legacy card's `trade_key`. V1 has no trade on the posting — the matchable
      // unit is the `mskill_*` id — so the matched skill id fills the slot honestly
      // rather than being left blank or back-derived through a bridge the spec retired.
      trade_key: row.matchedSkillId,
      title: row.roleTitle,
      // The legacy contract types `city` as a plain string. A V1 posting may have none
      // (the column is nullable), and "" is the honest empty rather than a fabricated
      // city — the client already renders a blank city row for the legacy nulls.
      city: row.city ?? "",
      // `area` does not exist on `job_postings`. Null is the honest answer; inventing
      // one from `location_label` would put payer free text on a worker card.
      area: null,
      // The experience WINDOW does not exist on `job_postings` either. Null both ends
      // reads as [0, ∞) to the client — "matches every band" — which is the liberal
      // pass-through the legacy feed documents, not a silent narrowing.
      min_experience_years: null,
      max_experience_years: null,
      pay_min: row.payMin,
      pay_max: row.payMax,
      shift: row.shift,
      rank: index + 1,
      via_related: row.matchTier === 2,
      matched_skill_label: matchSkillLabel(row.matchedSkillId) ?? null,
    }));

    if (page.length > 0) {
      await this.events.emitMany(
        page.map((row, index): EmitParams<"feed.shown_v2"> => {
          const payload: PayloadInputOf<"feed.shown_v2"> = {
            worker_id: workerId,
            job_posting_id: row.jobPostingId,
            rank: index + 1,
            match_tier: row.matchTier,
            boosted: row.boosted,
            matched_skill_id: row.matchedSkillId,
          };
          return {
            event_name: "feed.shown_v2",
            actor: { actor_type: "worker", actor_id: workerId },
            subject: { subject_type: "job_posting", subject_id: row.jobPostingId },
            payload,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
          };
        }),
      );
    }

    return { jobs: items };
  }
}

/**
 * How much wider than the page we read before interleaving. 3× is enough for the max-2
 * rule to have alternatives without turning a 20-card feed into a 200-row read.
 */
const OVERFETCH_MULTIPLIER = 3;
/** Absolute ceiling, so a large `limit` cannot make one request an unbounded scan. */
const OVERFETCH_CAP = 300;
