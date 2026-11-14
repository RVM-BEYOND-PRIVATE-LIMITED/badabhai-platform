import { BadRequestException, Injectable } from "@nestjs/common";
import { rvmReviewStateFor, type InstituteCode } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { isCanonicalUuid } from "../common/uuid";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PayerCreateJobPostingSchema } from "../job-postings/job-postings.dto";
import { PayersRepository } from "../payers/payers.repository";
import { isBarredPayerStatus } from "../payers/payer-barred-status";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { CampusRefusal } from "./campus-errors";
import {
  CAMPUS_EARLIEST_DECISION_TIME,
  type CampusPostForCompanyBodySchema,
} from "./campus-link.contract";
import { CampusPostingsRepository, type CampusFeedRow } from "./campus-postings.repository";
import type { z } from "zod";

const RVM: InstituteCode = "rvm";

/**
 * How far a `changed_since` read reaches back. `changed_at` is stamped by the application clock
 * before COMMIT, so a slower transaction can commit with an older stamp than one Campus already
 * read; re-reading this overlap (Campus de-duplicates by id) means no change is ever skipped.
 */
export const CAMPUS_FEED_OVERLAP_MS = 120_000;

const EARLIEST_MS = Date.parse(CAMPUS_EARLIEST_DECISION_TIME);

/**
 * Where a feed read with `changed_since` starts: the overlap before Campus's mark, but never before
 * `CAMPUS_EARLIEST_DECISION_TIME`. A year-0000 mark passes the schema and would fail Postgres's
 * `timestamptz` cast (22008, a 500); nothing the link records is older, so the clamp loses nothing.
 */
export function feedChangedSince(changedSince: string): Date {
  return new Date(Math.max(Date.parse(changedSince) - CAMPUS_FEED_OVERLAP_MS, EARLIEST_MS));
}

/** One posting in the Campus contract's shape (`CampusPostingSchema`, plus `content_hash`). */
export interface CampusPostingAnswer {
  id: string;
  company: { id: string; name: string };
  title: string;
  description: string | null;
  location: {
    label: string | null;
    city: string | null;
    state: string | null;
    area: string | null;
  };
  pay: { min: number | null; max: number | null; type: CampusFeedRow["payType"] };
  vacancy_band: CampusFeedRow["vacancyBand"];
  shift: CampusFeedRow["shift"];
  experience_years: { min: number | null; max: number | null };
  requirements: string[];
  benefits: string[];
  status: "open" | "closed";
  audience: CampusFeedRow["audience"];
  branch_ids: number[];
  courses: { id: string; name: string }[];
  review_state: "pending" | "approved" | "rejected";
  /** What the reviewer approves against (#2746 PR 5 requires it back on the review). */
  content_hash: string;
  changed_at: string;
}

/** An opaque feed cursor: the last row's `(changed_at, id)`. */
export function encodeFeedCursor(row: { changedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.changedAt.toISOString(), row.id])).toString("base64url");
}

export function decodeFeedCursor(cursor: string): { changedAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    const changedAt = new Date(String(at));
    if (typeof id !== "string" || !isCanonicalUuid(id) || Number.isNaN(changedAt.getTime())) {
      throw new Error("shape");
    }
    return { changedAt, id };
  } catch {
    throw new BadRequestException({ code: "VALIDATION_FAILED", message: "cursor is not valid" });
  }
}

/**
 * The Campus postings routes (#2752 part E): the feed of jobs marked for RVM students, posting
 * for a company, and finding a company Campus created. The review decision itself is #2746's
 * (`PUT job-postings/:id/review`); this side only reads it, through `@badabhai/db`'s one
 * definition of the hash and of "approved".
 *
 * POSTING FOR A COMPANY (owner decision taken 2026-11-14 on the security review). Campus may
 * publish only for a company IT created: a phone that already belongs to a BadaBhai company it did
 * not create is refused (`COMPANY_NOT_CAMPUS_CREATED`), and that company posts for RVM students
 * from its own account. So a Campus credential can never publish in another employer's name. A new
 * company is created `pending` (its owner activates it by signing in with a code), with the staff
 * reference in `audit_logs`. The posting is open, for RVM students, its review approved by
 * `staff_ref` against the content as stored.
 */
@Injectable()
export class CampusPostingsService {
  constructor(
    private readonly repo: CampusPostingsRepository,
    private readonly payers: PayersRepository,
    private readonly tenancy: PayerTenantScopeService,
    private readonly postings: JobPostingsService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  async feed(query: {
    review_state?: "pending" | "approved" | "rejected";
    branch_id?: number;
    course_id?: string;
    changed_since?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ postings: CampusPostingAnswer[]; next_cursor: string | null }> {
    const rows = await this.repo.listFeed({
      reviewState: query.review_state,
      branchId: query.branch_id,
      courseId: query.course_id,
      changedSince:
        query.changed_since === undefined ? undefined : feedChangedSince(query.changed_since),
      after: query.cursor === undefined ? undefined : decodeFeedCursor(query.cursor),
      // One row past the page says whether there is a next one.
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const labels = await this.repo.courseLabels([...new Set(page.flatMap((r) => r.courseIds))]);
    return {
      postings: page.map((row) => toAnswer(row, labels)),
      next_cursor: rows.length > query.limit ? encodeFeedCursor(page[page.length - 1]!) : null,
    };
  }

  /**
   * @throws CampusRefusal COMPANY_NOT_CAMPUS_CREATED — the phone is a company Campus did not create.
   */
  async postForCompany(
    body: z.infer<typeof CampusPostForCompanyBodySchema>,
    ctx: RequestContext,
  ): Promise<{ posting_id: string; company_id: string; company_created: boolean }> {
    // The company form's own validation (field limits, the worker-visible place screen), so a
    // Campus posting can hold nothing the company form would refuse. FIRST, so a body the posting
    // would refuse never leaves a company behind.
    const parsed = PayerCreateJobPostingSchema.safeParse({
      org_label: body.company.name,
      role_title: body.title,
      description: body.description.length > 0 ? body.description : undefined,
      location_label: body.location_label,
      city: body.city,
      state: body.state,
      vacancies: body.openings,
      pay_min: body.pay?.min,
      pay_max: body.pay?.max,
      pay_type: body.pay?.type,
    });
    if (!parsed.success) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join(".") || "(root)",
          message: i.message,
        })),
      });
    }
    const dto = parsed.data;

    const phone = `+91${body.company.phone}`;
    const { companyId, created } = await this.campusCompanyFor(phone, body, ctx);
    const scope = await this.ownerScope(companyId);
    // The posting is owned by the TENANT key. A company Campus created that has since joined
    // another employer's org would make that employer the owner: refused, so a Campus token never
    // publishes for a company it did not create.
    if (scope.tenantKey !== companyId) throw new CampusRefusal("COMPANY_NOT_CAMPUS_CREATED", 409);
    const posting = await this.postings.createForCampus(
      scope,
      dto,
      { rvm_branch_ids: body.branch_ids, rvm_course_ids: body.course_ids },
      ctx,
    );
    await this.repo.withTransaction((tx) =>
      this.repo.approveAsCreated(tx, posting.id, body.staff_ref),
    );
    return { posting_id: posting.id, company_id: companyId, company_created: created };
  }

  /**
   * The tenant scope the new posting is owned under. READ-ONLY FIRST (`resolveReadOnly`, #2746
   * PR 5): a Campus call is not the company's own, so it writes no shadow line. Only under tenancy
   * `on` can that come back empty: a company with no org yet (Campus created it and it has not
   * signed in) or one tenancy denies. The posting needs an owner, so `resolve` then gives the first
   * its solo org once, exactly as its first sign-in would, and refuses the second (403).
   */
  private async ownerScope(companyId: string): Promise<PayerTenantScope> {
    return (
      (await this.tenancy.resolveReadOnly(companyId)) ?? (await this.tenancy.resolve(companyId))
    );
  }

  /** The company Campus created with this phone, or null. Never a company Campus did not create. */
  async findCompany(
    phone10: string,
  ): Promise<{ id: string; name: string; status: "active" | "pending" } | null> {
    const rows = await this.repo.findCampusCompaniesByPhoneHash(
      this.pii.hashPhone(`+91${phone10}`),
    );
    const row = rows[0];
    if (!row || (row.status !== "active" && row.status !== "pending")) return null;
    return { id: row.id, name: this.pii.decrypt(row.orgNameEnc), status: row.status };
  }

  /**
   * The company to post for: a company Campus created with this phone, or a new pending one. A
   * phone held by a company Campus did not create, or a Campus company that is suspended or
   * archived, is refused.
   */
  private async campusCompanyFor(
    phone: string,
    body: z.infer<typeof CampusPostForCompanyBodySchema>,
    ctx: RequestContext,
  ): Promise<{ companyId: string; created: boolean }> {
    return this.repo.withTransaction(async (tx) => {
      // Phone-keyed, serialised on the phone hash inside this transaction (#2497's create-or-get).
      const { id, created } = await this.payers.createOrGet(
        { role: "employer", phone, orgName: body.company.name },
        tx,
      );
      if (!created) {
        const status = await this.repo.companyStatus(id, tx);
        if (!(await this.repo.isCampusCompany(id, tx)) || isBarredPayerStatus(status)) {
          throw new CampusRefusal("COMPANY_NOT_CAMPUS_CREATED", 409);
        }
        return { companyId: id, created: false };
      }
      await this.repo.markCampusCompany(tx, id, RVM, body.staff_ref);
      const payload: PayloadInputOf<"payer.institute_company_created"> = {
        payer_id: id,
        institute_code: RVM,
      };
      await this.events.emit({
        event_name: "payer.institute_company_created",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "payer", subject_id: id },
        payload,
        idempotencyKey: `payer.institute_company_created:${id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
      return { companyId: id, created: true };
    });
  }
}

function toAnswer(row: CampusFeedRow, labels: Map<string, string>): CampusPostingAnswer {
  return {
    id: row.id,
    // The posting's own display label (`org_label`), never the account's name: the review hash
    // covers this label, so a renamed company cannot reach students unreviewed.
    company: { id: row.companyId, name: row.orgLabel },
    title: row.roleTitle,
    description: row.description,
    location: { label: row.locationLabel, city: row.city, state: row.state, area: row.area },
    pay: { min: row.payMin, max: row.payMax, type: row.payType },
    vacancy_band: row.vacancyBand,
    shift: row.shift,
    experience_years: { min: row.minExperienceYears, max: row.maxExperienceYears },
    requirements: row.requirements ?? [],
    benefits: row.benefits ?? [],
    status: row.takesApplications ? "open" : "closed",
    audience: row.audience,
    branch_ids: row.branchIds,
    courses: row.courseIds.map((id) => ({ id, name: labels.get(id) ?? id })),
    review_state: rvmReviewStateFor(row.audience, row.reviewStateNow) ?? "pending",
    content_hash: row.contentHash,
    changed_at: row.changedAt.toISOString(),
  };
}
