import { Injectable } from "@nestjs/common";
import { interleaveMaxPerCompany } from "@badabhai/match-engine";
import { matchSkillLabel } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { TradeFormKindName } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { toWorkerRoleKind } from "../common/worker-role-kind";
import { EventsService, type EmitParams } from "../events/events.service";
import { MatchConfigService } from "./match-config.service";
import {
  MatchFeedRepository,
  type MatchFeedFilters,
  type MatchFeedKey,
  type MatchFeedRow,
} from "./match-feed.repository";

/**
 * #1961 — where the next V1 page resumes (ADR-0052). `after` is the FRONTIER: every row up to
 * and including it in the repository's order has been served. `ahead` holds the ids served
 * BEYOND the frontier, because the E14 interleave pulled them forward over a row it deferred.
 */
export interface MatchFeedResume {
  after: MatchFeedKey;
  ahead: readonly string[];
}

/** One composed V1 page and where the next one resumes (`null` = the deck is exhausted). */
export interface MatchFeedPage {
  rows: MatchFeedRow[];
  next: MatchFeedResume | null;
}

/** A follow-on page request: where to resume, and how many cards this scroll already served. */
export interface MatchFeedContinuation {
  resume: MatchFeedResume;
  rankOffset: number;
}

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
  /**
   * WHAT THE PAY BAND MEANS (#1648): `in_hand` | `gross` | `ctc`, or NULL for "the poster
   * did not state it" — in which case the card shows the band with no pay-type pill. Never
   * defaulted, never inferred: the worker's first question deserves a real answer or none.
   */
  pay_type: string | null;
  shift: string | null;
  /**
   * Worker-visible card content (#1561, migration 0116). ADDITIVE — a client that ignores
   * them renders exactly what it rendered before. All nullable; NULL is honest absence
   * (a posting created before the migration, or a poster who left the field blank).
   */
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
  needed_by: string | null;
  /**
   * WHEN THIS POSTING BECAME WORKER-VISIBLE (#1649). ONE key across both feed shapes —
   * `job_postings.published_at` here, `jobs.created_at` on the legacy path — because a
   * client cannot be expected to know which source served it, and two keys would make the
   * "naye jobs" count depend on a flag.
   *
   * ISO-8601 UTC, or NULL. NULL is honest: a posting can be served with `published_at`
   * unset (the D3 backfill leaves pre-cutover rows alone), and the app must render those
   * without a NEW badge rather than treat "unknown" as "today". The Jobs-tab header used
   * to say "Aaj N naye jobs" while the feed carried no date at all, so a job seeded months
   * ago counted as posted today — this key is what makes that claim checkable.
   */
  posted_at: string | null;
  rank: number;
  /** E18 — he was reached through a RELATED skill, not the posted one. */
  via_related: boolean;
  /** E18 — the skill that earned the match, for the badge. */
  matched_skill_label: string | null;
  /**
   * THE POSTING'S ROLE, FOR THE CARD'S ILLUSTRATION (owner ruling 2026-10-05, ADR-0024 addendum).
   * One of the 21 declared kinds or NULL ("no role picked" — every pre-0131 and chat-published
   * posting). ADDITIVE: a client that ignores it renders what it rendered before. Drawn as art,
   * never as text, and never a match/rank input. Not on `feed.shown_v2`.
   */
  role_kind: TradeFormKindName | null;
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
    continuation?: MatchFeedContinuation,
  ): Promise<{ jobs: MatchFeedItem[]; next: MatchFeedResume | null }> {
    const { rows: page, next } = await this.composeFrom(
      workerId,
      limit,
      filters,
      continuation?.resume,
    );
    // #1961: `rank` is the position in the DECK, so a follow-on page continues the count.
    const rankOffset = continuation?.rankOffset ?? 0;

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
      // Card content (#1561): straight pass-through of the posting's own columns, nulls
      // preserved — a posting with no area/experience/content shows none, it is never
      // fabricated and never drops the card. `location_label` is still never read here:
      // deriving `area` from poster free text would put payer free text on a worker card.
      area: row.area,
      min_experience_years: row.minExperienceYears,
      max_experience_years: row.maxExperienceYears,
      pay_min: row.payMin,
      pay_max: row.payMax,
      pay_type: row.payType,
      shift: row.shift,
      description: row.description,
      benefits: row.benefits,
      requirements: row.requirements,
      needed_by: row.neededBy,
      // Already a sort key of this feed (boost, then tier, then recency, then id) — it was
      // simply never projected, so the client could not see the order it was being served.
      posted_at: row.publishedAt === null ? null : row.publishedAt.toISOString(),
      rank: rankOffset + index + 1,
      via_related: row.matchTier === 2,
      matched_skill_label: matchSkillLabel(row.matchedSkillId) ?? null,
      // Fail closed: only a declared kind or null leaves the API.
      role_kind: toWorkerRoleKind(row.roleKind),
    }));

    if (page.length > 0) {
      await this.events.emitMany(
        page.map((row, index): EmitParams<"feed.shown_v2"> => {
          const payload: PayloadInputOf<"feed.shown_v2"> = {
            worker_id: workerId,
            job_posting_id: row.jobPostingId,
            rank: rankOffset + index + 1,
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

    return { jobs: items, next };
  }

  /**
   * THE FEED'S ORDER, AND NOTHING ELSE — the rows {@link getFeed} serves, in the order it
   * serves them, with no event emitted.
   *
   * It is the single place the page is composed (the repository's ORDER BY, the overfetch,
   * the E14 interleave, the truncation), so a read-only consumer — the admin Engine view
   * (`AdminMatchEngineService`) — shows exactly what the worker is shown without copying
   * any of it. `getFeed` is this plus `feed.shown_v2`; an admin LOOKING at a worker's feed
   * is not the worker being shown it, so the admin path must not emit that event.
   */
  async composePage(
    workerId: string,
    limit: number,
    filters: MatchFeedFilters,
  ): Promise<MatchFeedRow[]> {
    return (await this.composeFrom(workerId, limit, filters)).rows;
  }

  /**
   * {@link composePage} from a resume point, plus where the page after it resumes (#1961,
   * ADR-0052). With no `resume` this is the first page, composed exactly as before: the same
   * read (no keyset clause), the same overfetch, the same interleave, the same truncation.
   *
   * WHY A FRONTIER AND AN AHEAD SET, NOT "THE LAST CARD". The E14 interleave permutes the
   * overfetched batch, so the served page is not a prefix of the SQL order: a row can be
   * DEFERRED (held back to break a company run) while a later row is PULLED FORWARD. Resuming
   * after the last served card would skip the deferred row; resuming after the last card of the
   * served PREFIX would repeat the pulled-forward one. So the resume point is both:
   *
   *   - `after`  the last row of the longest fully-served prefix of the batch (the frontier);
   *   - `ahead`  every id served beyond that frontier. The next read starts after the frontier
   *              and drops these, so they count as served but are never shown twice.
   *
   * An `ahead` id the next batch does not contain stays carried (it lies beyond that batch, or
   * has left the deck). One the batch places at or before the new frontier is dropped.
   *
   * THE INTERLEAVE RESTARTS AT EACH PAGE. `interleaveMaxPerCompany` starts every call with no
   * open run, so the max-N rule holds WITHIN a page; across a page boundary up to 2N cards from
   * one company can sit back to back. Carrying the run across would put the company key in a
   * client-held cursor, which ADR-0036 keeps server-side.
   */
  async composeFrom(
    workerId: string,
    limit: number,
    filters: MatchFeedFilters,
    resume?: MatchFeedResume,
  ): Promise<MatchFeedPage> {
    const cfg = await this.config.get();

    const overfetch = Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
    // The first page's read is the pre-cursor call, argument for argument.
    const batch =
      resume === undefined
        ? await this.repo.listFeed(workerId, overfetch, filters)
        : await this.repo.listFeed(workerId, overfetch, filters, resume.after);
    const carried = new Set(resume?.ahead ?? []);
    const candidates = batch.filter((row) => !carried.has(row.jobPostingId));

    // E14 — at most `max_consecutive_same_company` cards in a row from one company.
    // Keyed on `payer_id`, falling back to `created_by` for ops-created postings, so an
    // ops actor bulk-loading a register does not flood one worker's feed either.
    const interleaved = interleaveMaxPerCompany(candidates, cfg.maxConsecutiveSameCompany);
    const rows = interleaved.slice(0, limit);

    // The deck is exhausted when nothing in this batch is left unserved AND the batch was not
    // cut short by the overfetch (a full batch may have more rows behind it).
    const unservedInBatch = interleaved.length > rows.length;
    if (!unservedInBatch && batch.length < overfetch) return { rows, next: null };
    return { rows, next: nextResume(batch, rows, carried, resume?.after) };
  }
}

/** The frontier and ahead set after serving `rows` out of `batch` (see `composeFrom`). */
function nextResume(
  batch: readonly MatchFeedRow[],
  rows: readonly MatchFeedRow[],
  carried: ReadonlySet<string>,
  previous: MatchFeedKey | undefined,
): MatchFeedResume | null {
  const served = new Set<string>(carried);
  for (const row of rows) served.add(row.jobPostingId);

  let prefix = 0;
  while (prefix < batch.length && served.has(batch[prefix]!.jobPostingId)) prefix += 1;

  const frontierRow = prefix > 0 ? batch[prefix - 1] : undefined;
  const after = frontierRow === undefined ? previous : keyOf(frontierRow);
  // Nothing served and no earlier frontier: there is no position to resume from.
  if (after === undefined) return null;

  const inBatch = new Set(batch.map((row) => row.jobPostingId));
  const aheadInBatch = batch
    .slice(prefix)
    .map((row) => row.jobPostingId)
    .filter((id) => served.has(id));
  const aheadBeyondBatch = [...carried].filter((id) => !inBatch.has(id));
  return { after, ahead: [...aheadInBatch, ...aheadBeyondBatch] };
}

/** A served row's position in the repository's ORDER BY. */
function keyOf(row: MatchFeedRow): MatchFeedKey {
  return {
    boosted: row.boosted,
    matchTier: row.matchTier,
    publishedKey: row.publishedKey,
    id: row.jobPostingId,
  };
}

/**
 * How much wider than the page we read before interleaving. 3× is enough for the max-2
 * rule to have alternatives without turning a 20-card feed into a 200-row read.
 */
const OVERFETCH_MULTIPLIER = 3;
/** Absolute ceiling, so a large `limit` cannot make one request an unbounded scan. */
const OVERFETCH_CAP = 300;
