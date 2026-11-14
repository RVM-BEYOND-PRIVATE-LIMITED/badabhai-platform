import { ConflictException, Injectable, Logger } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { RVM_INSTITUTE_CODE, type RvmTargetingKind } from "@badabhai/db";
import type { z } from "zod";
import { EventsService } from "../events/events.service";
import type {
  CampusErrorCode,
  CampusTargetingOptionsBodySchema,
  CampusTargetingOptionsResponseSchema,
} from "./campus-link.contract";
import type { CampusCall } from "./campus-call";
import { assertNotAheadOfBadaBhai } from "./campus-clock";
import {
  CampusTargetingOptionsRepository,
  type StoredTargetingOption,
  type TargetingOptionRetirement,
  type TargetingOptionWrite,
} from "./campus-targeting-options.repository";

/** The parsed body of `PUT targeting-options`. */
export type CampusTargetingOptionsList = z.output<typeof CampusTargetingOptionsBodySchema>;

/** The answer: what the replacement did, per kind. */
export type CampusTargetingOptionsResult = z.input<typeof CampusTargetingOptionsResponseSchema>;

/** One kind's counts. */
type KindCounts = CampusTargetingOptionsResult["branches"];

/** What a replacement must write, decided from the stored rows and the list Campus sent. */
export interface TargetingReplacementPlan {
  writes: TargetingOptionWrite[];
  retire: TargetingOptionRetirement;
  counts: CampusTargetingOptionsResult;
}

/**
 * THE REPLACEMENT RULE, pure. Per kind: a ref in the list is written when it is new (`added`) or
 * when its label, its position or its active flag differs (`updated`); a stored ACTIVE ref missing
 * from the list is retired (`deactivated`); an inactive ref missing from the list is left alone. An
 * option's order is its position in Campus's list. A branch ref is the location id as text, the
 * form `rvm_targeting_options.ref` stores (`rto_branch_ref_chk`).
 */
export function planTargetingReplacement(
  stored: readonly StoredTargetingOption[],
  list: CampusTargetingOptionsList,
): TargetingReplacementPlan {
  const entries: Record<RvmTargetingKind, { ref: string; label: string }[]> = {
    branch: list.branches.map((b) => ({ ref: String(b.id), label: b.name })),
    course: list.courses.map((c) => ({ ref: c.id, label: c.name })),
  };
  const writes: TargetingOptionWrite[] = [];
  const retire: Record<RvmTargetingKind, string[]> = { branch: [], course: [] };
  const counts: Record<RvmTargetingKind, KindCounts> = {
    branch: { listed: 0, added: 0, updated: 0, deactivated: 0 },
    course: { listed: 0, added: 0, updated: 0, deactivated: 0 },
  };

  for (const kind of ["branch", "course"] as const) {
    const known = new Map(stored.filter((s) => s.kind === kind).map((s) => [s.ref, s]));
    const listed = new Set<string>();
    entries[kind].forEach(({ ref, label }, sortOrder) => {
      listed.add(ref);
      const current = known.get(ref);
      if (current === undefined) {
        counts[kind].added += 1;
      } else if (current.label !== label || current.sortOrder !== sortOrder || !current.active) {
        counts[kind].updated += 1;
      } else {
        return;
      }
      writes.push({ kind, ref, label, sortOrder });
    });
    counts[kind].listed = listed.size;
    for (const option of known.values()) {
      if (option.active && !listed.has(option.ref)) retire[kind].push(option.ref);
    }
    counts[kind].deactivated = retire[kind].length;
  }

  return { writes, retire, counts: { branches: counts.branch, courses: counts.course } };
}

function changed(counts: CampusTargetingOptionsResult): boolean {
  return [counts.branches, counts.courses].some((c) => c.added + c.updated + c.deactivated > 0);
}

/**
 * #2746 PR 5 — CAMPUS SETS THE BRANCHES AND COURSES A COMPANY MAY TARGET (`PUT targeting-options`,
 * mounted only behind `CampusServiceGuard`; no other gate: the options are global, and the company
 * side, `GET /payer/job-postings/audience-options`, is switched per company already).
 *
 * Campus sends the WHOLE current list, with the `as_of` it read it at. An `as_of` more than
 * `CAMPUS_MAX_CLOCK_SKEW_MS` ahead of BadaBhai's clock is 400 `VALIDATION_FAILED`. One
 * transaction, serialised by an advisory lock:
 *   - `as_of` NEWER than the last applied list (or nothing applied yet): upsert the listed options
 *     (label, order = list position, active), retire every active option not listed, stamp every
 *     row with `as_of` (the high-water mark, `CampusTargetingOptionsRepository`), and — only when
 *     the list changed — emit `job_posting.rvm_targeting_options_set` v1 (counts only) and write
 *     the `audit_logs` row;
 *   - `as_of` the same as or older than the last applied list: when the list equals what is held,
 *     a replay (200, nothing written); when it differs, 409 `DECISION_SUPERSEDED`, nothing written,
 *     so a late retry never puts back an option Campus has since removed.
 * Never a delete: postings hold the refs, and a posting that targets a retired option keeps it
 * (`PostingAudienceService` lets a company re-send what it already holds). The `Idempotency-Key` is
 * required and checked, not stored: the same body again is the replay above.
 */
@Injectable()
export class CampusTargetingOptionsService {
  private readonly logger = new Logger(CampusTargetingOptionsService.name);

  constructor(
    private readonly repo: CampusTargetingOptionsRepository,
    private readonly events: EventsService,
  ) {}

  async replace(
    list: CampusTargetingOptionsList,
    call: CampusCall,
  ): Promise<CampusTargetingOptionsResult> {
    assertNotAheadOfBadaBhai("as_of", list.as_of);
    return this.repo.withTransaction(async (tx) => {
      await this.repo.lockForReplace(tx);
      const timing = await this.repo.listTiming(tx, list.as_of);
      const plan = planTargetingReplacement(await this.repo.listAll(tx), list);
      const { counts } = plan;

      if (timing === "same" || timing === "older") {
        // Not newer than what is applied: a replay of the same list, or a late one that differs.
        if (changed(counts)) {
          this.logger.log("campus targeting options: refused, a newer list is applied");
          throw new ConflictException({
            code: "DECISION_SUPERSEDED" satisfies CampusErrorCode,
          });
        }
        return counts;
      }

      await this.repo.upsert(tx, plan.writes, list.as_of);
      await this.repo.retire(tx, plan.retire);
      await this.repo.stampAll(tx, list.as_of);

      if (changed(counts)) {
        const payload: PayloadInputOf<"job_posting.rvm_targeting_options_set"> = {
          institute_code: RVM_INSTITUTE_CODE,
          as_of: list.as_of,
          branches: counts.branches,
          courses: counts.courses,
        };
        const event = await this.events.emit({
          event_name: "job_posting.rvm_targeting_options_set",
          actor: { actor_type: "system", actor_id: null },
          subject: { subject_type: "job_posting", subject_id: null },
          payload,
          correlationId: call.ctx.correlationId,
          requestId: call.ctx.requestId,
          tx,
        });
        await this.repo.writeAudit(tx, call.callId, {
          institute_code: RVM_INSTITUTE_CODE,
          as_of: list.as_of,
          branches: counts.branches,
          courses: counts.courses,
          event_id: event.event_id,
        });
      }

      this.logger.log(
        `campus targeting options: branches=${summary(counts.branches)} courses=${summary(counts.courses)}`,
      );
      return counts;
    });
  }
}

function summary(c: KindCounts): string {
  return `${c.listed}/+${c.added}/~${c.updated}/-${c.deactivated}`;
}
