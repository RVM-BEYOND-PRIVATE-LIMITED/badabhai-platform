import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  applications,
  createDbClient,
  instituteApplications,
  instituteCompanies,
  jobPostingInstituteReviews,
  jobPostingWorkerVisibility,
  jobPostings,
  payers,
  type DbClient,
  type JobPostingAudience,
} from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { ApplicationsRepository } from "../applications/applications.repository";
import { ApplicationsService } from "../applications/applications.service";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { JobsRepository } from "../jobs/jobs.repository";
import { postingAudienceOver } from "../job-postings/posting-audience.test-support";
import { MatchCandidatesService } from "../match/match-candidates.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { PrePayFactsRepository } from "../match/pre-pay-facts.repository";
import { PrePayFactsService } from "../match/pre-pay-facts.service";
import { stagesOff } from "../payer-portal/payer-applicant-stages.test-support";
import { PayerApplicantsService } from "../payer-portal/payer-applicants.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { PayersRepository } from "../payers/payers.repository";
import { ReachRepository } from "../reach/reach.repository";
import { ReachService } from "../reach/reach.service";
import { WorkersRepository } from "../workers/workers.repository";
import { CampusApplicationsRepository } from "./campus-applications.repository";
import { CampusApplicationsService } from "./campus-applications.service";
import { CampusRefusal } from "./campus-errors";
import { CampusPostingsRepository } from "./campus-postings.repository";
import { CampusPostingsService } from "./campus-postings.service";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService } from "./institute-link.service";
import type { RvmStudentApiClient, RvmStudentLookup } from "./rvm-student-api.client";

/**
 * #2752 part E — the Campus jobs and applications routes, against Postgres (the issue's checks):
 *   - of three postings (workers only, RVM only, both) the feed returns the last two, pending
 *     until approved, with the review hash; a company edit after approval reads pending again;
 *   - a student applies only to an approved, open posting for RVM students; sent twice it is one
 *     row; the company's applicant list labels him `rvm`; his stage and his withdrawal reach the
 *     status feed, and a withdrawal takes him off the company's list;
 *   - posting for a company creates a pending company Campus owns, an open RVM posting approved
 *     by the staff ref, and it appears in the feed; a phone that is a company Campus did not create
 *     is refused, and the company lookup answers only Campus-created companies;
 *   - #2753 item 8, the worker side: the student's own `GET workers/me/applications` lists his
 *     Campus application in the row every application has, marked `via: 'campus'`; the company's
 *     applicant list shows him as `source: 'rvm_student'`; a Campus withdrawal takes it off both.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`campus-jobs.db refuses to write to a non-local host (${host})`);
  }
}

const CTX: RequestContext = { correlationId: randomUUID(), requestId: "campus-jobs-db" };
const TAG = randomUUID().slice(0, 8);
const STAFF = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const phone10 = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

describe.skipIf(!RUN)("#2752 part E — Campus jobs and applications against Postgres", () => {
  let client!: DbClient;
  let pii!: PiiCryptoService;
  let postingsRepo!: CampusPostingsRepository;
  let campusPostings!: CampusPostingsService;
  let campusApps!: CampusApplicationsService;
  let feedRepo!: MatchFeedRepository;
  /** The company form's posting service with the audience switch ON (a company may pick one). */
  let companyForm!: JobPostingsService;
  /** `GET workers/me/applications` (#2753 item 8): the worker's own list. */
  let workerApps!: ApplicationsService;
  /** `GET /payer/reach/jobs/:jobId/applicants`, the company's list, `applicant_facts` off. */
  let companyList!: PayerApplicantsService;
  const students = new Map<string, RvmStudentLookup>();
  const touchedPayers: string[] = [];
  const touchedWorkers = new Set<string>();
  let companyId!: string;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: "campus-jobs-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      PIN_PEPPER: "campus-jobs-test-pin",
    } as never);
    const tenancy = new PayerTenantScopeService(
      { PAYER_ORG_TENANCY_MODE: "off" } as never,
      {
        listActiveMembershipsWithAnchor: async () => [],
        ensureSoloOrg: async () => null,
      } as unknown as PayerOrgsRepository,
    );
    const rvm = {
      readStudent: async (ref: string) => {
        const answer = students.get(ref);
        if (!answer) throw new Error(`no fake student for ${ref}`);
        return answer;
      },
    } as unknown as RvmStudentApiClient;
    const links = new InstituteLinkService(
      new InstituteLinkRepository(client.db),
      new WorkersRepository(client.db),
      rvm,
      pii,
      events,
      { RVM_CONSENT_RECHECK_SECONDS: 300 } as never,
    );
    const jobPostingsService = new JobPostingsService(
      new JobPostingsRepository(client.db),
      events,
      {} as never, // AiService — no skill phrases, so canonicalization returns before any call
      {} as never, // AiCostRecorder — likewise
      {} as never, // AiTraceRecorder — likewise
      { materialize: async () => undefined } as never, // an RVM-only posting reaches no worker
      { resolveForPublish: async () => undefined } as never,
      {} as never, // PostingTradesService
      tenancy,
      postingAudienceOver(client.db, events),
    );
    postingsRepo = new CampusPostingsRepository(client.db);
    campusPostings = new CampusPostingsService(
      postingsRepo,
      new PayersRepository(client.db, pii),
      tenancy,
      jobPostingsService,
      pii,
      events,
    );
    campusApps = new CampusApplicationsService(
      new CampusApplicationsRepository(client.db),
      links,
      events,
    );
    feedRepo = new MatchFeedRepository(client.db);
    companyForm = new JobPostingsService(
      new JobPostingsRepository(client.db),
      events,
      {} as never,
      {} as never,
      {} as never,
      { materialize: async () => undefined } as never,
      { resolveForPublish: async () => undefined } as never,
      {} as never,
      tenancy,
      postingAudienceOver(client.db, events, { JOB_AUDIENCE_ROLLOUT: "on" }),
    );
    // The list reads only the repository; the feed and apply collaborators stay unbuilt.
    workerApps = new ApplicationsService(
      new ApplicationsRepository(client.db),
      events,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    companyList = new PayerApplicantsService(
      new ReachService(new ReachRepository(client.db), events, {} as never),
      jobPostingsService,
      new MatchCandidatesService(new MatchFeedRepository(client.db), {
        get: async () => DEFAULT_MATCH_CONFIG,
      } as never),
      stagesOff(),
      tenancy,
      new PrePayFactsService(
        new PrePayFactsRepository(client.db),
        { isEnabledFor: async () => false } as unknown as FeatureRolloutService,
        pii,
      ),
    );

    const [payer] = await client.db
      .insert(payers)
      .values({
        role: "employer",
        emailEnc: `enc:2752e-${TAG}`,
        emailHash: `hash:2752e-${TAG}`,
        orgNameEnc: `enc:company-${TAG}`,
        status: "active",
      })
      .returning({ id: payers.id });
    companyId = payer!.id;
    touchedPayers.push(companyId);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      for (const id of touchedWorkers) {
        await client.sql`DELETE FROM audit_logs WHERE entity_id = ${id}::uuid`;
        await client.sql`DELETE FROM workers WHERE id = ${id}::uuid`;
      }
      for (const id of touchedPayers) {
        await client.sql`DELETE FROM audit_logs WHERE entity_id = ${id}::uuid`;
        await client.sql`DELETE FROM job_postings WHERE payer_id = ${id}::uuid`;
        await client.sql`DELETE FROM payers WHERE id = ${id}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  async function posting(audience: JobPostingAudience, status = "open"): Promise<string> {
    const [row] = await client.db
      .insert(jobPostings)
      .values({
        createdBy: companyId,
        payerId: companyId,
        orgLabel: `Company ${TAG}`,
        roleTitle: "CNC Operator",
        vacancyBand: "2-5",
        status: status as never,
        audience,
      })
      .returning({ id: jobPostings.id });
    return row!.id;
  }

  const approve = (postingId: string) =>
    postingsRepo.withTransaction((tx) => postingsRepo.approveAsCreated(tx, postingId, STAFF));

  function aStudent() {
    const ref = randomUUID();
    students.set(ref, {
      kind: "available",
      student: {
        name: "Test Student",
        phone: phone10(),
        course: "CNC Programming",
        branch: "Faridabad",
        status: "current_student",
        test_score: null,
      },
    });
    return ref;
  }

  async function applied(postingId: string) {
    const studentRef = aStudent();
    const externalRef = `campus-app-${randomUUID().slice(0, 12)}`;
    const out = await campusApps.apply(
      { external_ref: externalRef, posting_id: postingId, student_ref: studentRef },
      CTX,
    );
    const row = (
      await client.db.select().from(applications).where(eq(applications.jobPostingId, postingId))
    ).find((a) => a.workerId !== undefined);
    if (row) touchedWorkers.add(row.workerId);
    return { ...out, studentRef, externalRef };
  }

  const refusalCode = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CampusRefusal);
    return (err as CampusRefusal).code;
  };

  it("lists the RVM-only and both postings, not the workers-only one, pending until approved", async () => {
    const workersOnly = await posting("badabhai_workers");
    const rvmOnly = await posting("rvm_students");
    const both = await posting("both");

    const page = await campusPostings.feed({ limit: 200 });
    const ids = page.postings.map((p) => p.id);
    expect(ids).toContain(rvmOnly);
    expect(ids).toContain(both);
    expect(ids).not.toContain(workersOnly);
    const listed = page.postings.find((p) => p.id === rvmOnly)!;
    expect(listed.review_state).toBe("pending");
    expect(listed.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(listed.company).toEqual({ id: companyId, name: `Company ${TAG}` });

    await approve(rvmOnly);
    const after = await campusPostings.feed({ limit: 200, review_state: "approved" });
    expect(after.postings.map((p) => p.id)).toContain(rvmOnly);
  });

  it("takes an application only for an approved, open posting for RVM students", async () => {
    const pending = await posting("rvm_students");
    const workersOnly = await posting("badabhai_workers");
    const closed = await posting("rvm_students", "closed");
    await approve(closed);

    const ext = () => `campus-app-${randomUUID().slice(0, 12)}`;
    expect(
      await refusalCode(
        campusApps.apply(
          { external_ref: ext(), posting_id: pending, student_ref: aStudent() },
          CTX,
        ),
      ),
    ).toBe("POSTING_NOT_APPROVED");
    expect(
      await refusalCode(
        campusApps.apply(
          { external_ref: ext(), posting_id: workersOnly, student_ref: aStudent() },
          CTX,
        ),
      ),
    ).toBe("AUDIENCE_EXCLUDES_RVM");
    expect(
      await refusalCode(
        campusApps.apply({ external_ref: ext(), posting_id: closed, student_ref: aStudent() }, CTX),
      ),
    ).toBe("POSTING_NOT_OPEN");
  });

  it("is one application when sent twice, labelled an RVM student on the company's list", async () => {
    const postingId = await posting("rvm_students");
    await approve(postingId);

    const first = await applied(postingId);
    const again = await campusApps.apply(
      { external_ref: first.externalRef, posting_id: postingId, student_ref: first.studentRef },
      CTX,
    );

    expect(first.created).toBe(true);
    expect(first.application.stage).toBe("new");
    expect(again).toEqual({ created: false, application: first.application });
    const rows = await client.db
      .select()
      .from(applications)
      .where(eq(applications.jobPostingId, postingId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceSurface).toBe("other");
    const listed = await feedRepo.listCandidates(postingId, 0, 50);
    expect(listed.map((c) => c.instituteCode)).toEqual(["rvm"]);
    // The same ref for another posting is a conflict.
    expect(
      await refusalCode(
        campusApps.apply(
          {
            external_ref: first.externalRef,
            posting_id: randomUUID(),
            student_ref: first.studentRef,
          },
          CTX,
        ),
      ),
    ).toBe("EXTERNAL_REF_CONFLICT");
  });

  it("reads pending again after a company edit, and refuses new applications", async () => {
    const postingId = await posting("rvm_students");
    await approve(postingId);
    await client.db
      .update(jobPostings)
      .set({ roleTitle: "CNC Setter" })
      .where(eq(jobPostings.id, postingId));

    const page = await campusPostings.feed({ limit: 200 });
    expect(page.postings.find((p) => p.id === postingId)?.review_state).toBe("pending");
    expect(
      await refusalCode(
        campusApps.apply(
          {
            external_ref: `campus-app-${randomUUID().slice(0, 12)}`,
            posting_id: postingId,
            student_ref: aStudent(),
          },
          CTX,
        ),
      ),
    ).toBe("POSTING_NOT_APPROVED");
  });

  it("feeds his stage and his withdrawal; a withdrawal takes him off the company's list", async () => {
    const postingId = await posting("rvm_students");
    await approve(postingId);
    const app = await applied(postingId);
    const workerId = [...touchedWorkers].at(-1)!;
    await client.sql`
      INSERT INTO payer_applicant_stages (posting_kind, posting_id, worker_id, stage, actor_payer_id)
      VALUES ('company_posting', ${postingId}::uuid, ${workerId}::uuid, 'shortlist', ${companyId}::uuid)`;

    const shortlisted = await campusApps.feed({ limit: 200 });
    expect(shortlisted.applications.find((a) => a.external_ref === app.externalRef)?.stage).toBe(
      "shortlist",
    );

    const withdrawn = await campusApps.withdraw(app.externalRef, CTX);
    const again = await campusApps.withdraw(app.externalRef, CTX);
    expect(withdrawn.stage).toBe("withdrawn");
    expect(again.stage).toBe("withdrawn");
    expect(await feedRepo.listCandidates(postingId, 0, 50)).toHaveLength(0);
    const fed = await campusApps.feed({ limit: 200 });
    expect(fed.applications.find((a) => a.external_ref === app.externalRef)?.stage).toBe(
      "withdrawn",
    );
  });

  it("keeps the application he made in the app himself when he withdraws on Campus", async () => {
    const postingId = await posting("rvm_students");
    await approve(postingId);
    // He applies on Campus first, so he is linked; then his own app apply is simulated by marking
    // the row as not Campus-owned (the path a worker-app apply before Campus takes).
    const app = await applied(postingId);
    await client.sql`
      UPDATE institute_applications SET owns_application = false
      WHERE external_ref = ${app.externalRef}`;

    await campusApps.withdraw(app.externalRef, CTX);

    expect(await feedRepo.listCandidates(postingId, 0, 50)).toHaveLength(1);
  });

  it("turns an earlier skip into the apply, and lets him apply again after a withdrawal", async () => {
    const postingId = await posting("rvm_students");
    await approve(postingId);
    const first = await applied(postingId);
    const workerId = [...touchedWorkers].at(-1)!;
    await campusApps.withdraw(first.externalRef, CTX);
    // A skip he made in the app in the meantime.
    await client.db
      .insert(applications)
      .values({ jobPostingId: postingId, workerId, action: "skipped", reason: "other" });

    const again = await campusApps.apply(
      {
        external_ref: `campus-app-${randomUUID().slice(0, 12)}`,
        posting_id: postingId,
        student_ref: first.studentRef,
      },
      CTX,
    );

    expect(again.created).toBe(true);
    const rows = await client.db
      .select()
      .from(applications)
      .where(eq(applications.jobPostingId, postingId));
    expect(rows.map((r) => r.action)).toEqual(["applied"]);
  });

  it("refuses to post for a Campus company that is suspended", async () => {
    const phone = phone10();
    const out = await campusPostings.postForCompany(
      {
        company: { phone, name: `Campus Co ${TAG}` },
        title: "CNC Operator",
        description: "",
        city: "Faridabad",
        openings: 1,
        branch_ids: [],
        course_ids: [],
        staff_ref: STAFF,
      },
      CTX,
    );
    touchedPayers.push(out.company_id);
    await client.db
      .update(payers)
      .set({ status: "suspended" })
      .where(eq(payers.id, out.company_id));

    expect(
      await refusalCode(
        campusPostings.postForCompany(
          {
            company: { phone, name: `Campus Co ${TAG}` },
            title: "CNC Operator",
            description: "",
            city: "Faridabad",
            openings: 1,
            branch_ids: [],
            course_ids: [],
            staff_ref: STAFF,
          },
          CTX,
        ),
      ),
    ).toBe("COMPANY_NOT_CAMPUS_CREATED");
  });

  it("posts for a company it creates, pending, approved by the staff ref, and finds only that company", async () => {
    const phone = phone10();
    const out = await campusPostings.postForCompany(
      {
        company: { phone, name: `Campus Co ${TAG}` },
        title: "AutoCAD Draughtsman",
        description: "Draw shop drawings.",
        city: "Faridabad",
        openings: 3,
        branch_ids: [],
        course_ids: [],
        staff_ref: STAFF,
      },
      CTX,
    );
    touchedPayers.push(out.company_id);

    expect(out.company_created).toBe(true);
    const [company] = await client.db.select().from(payers).where(eq(payers.id, out.company_id));
    expect(company?.status).toBe("pending");
    expect(
      await client.db
        .select()
        .from(instituteCompanies)
        .where(eq(instituteCompanies.payerId, out.company_id)),
    ).toHaveLength(1);
    const [review] = await client.db
      .select()
      .from(jobPostingInstituteReviews)
      .where(
        and(
          eq(jobPostingInstituteReviews.jobPostingId, out.posting_id),
          eq(jobPostingInstituteReviews.instituteCode, "rvm"),
        ),
      );
    expect(review).toMatchObject({ state: "approved", reviewerRef: STAFF });
    const page = await campusPostings.feed({ limit: 200, review_state: "approved" });
    // #2891 — for RVM students AND BadaBhai workers, held from the workers until an admin opens it.
    expect(page.postings.find((p) => p.id === out.posting_id)?.audience).toBe("both");
    const [hold] = await client.db
      .select()
      .from(jobPostingWorkerVisibility)
      .where(eq(jobPostingWorkerVisibility.jobPostingId, out.posting_id));
    expect(hold).toMatchObject({
      state: "off",
      origin: "campus_posted",
      decidedAt: null,
      decidedByAdminId: null,
    });
    const workerJobs = new JobsRepository(client.db);
    expect(await workerJobs.findWorkerVisibleJobById(out.posting_id)).toBeUndefined();

    expect(await campusPostings.findCompany(phone)).toMatchObject({
      id: out.company_id,
      status: "pending",
    });
    // A second posting for the same Campus company reuses it.
    const second = await campusPostings.postForCompany(
      {
        company: { phone, name: `Campus Co ${TAG}` },
        title: "SolidWorks Designer",
        description: "",
        city: "Faridabad",
        openings: 1,
        branch_ids: [],
        course_ids: [],
        staff_ref: STAFF,
      },
      CTX,
    );
    expect(second).toMatchObject({ company_id: out.company_id, company_created: false });

    // The posting opened without the company publish gate: held, it reaches no worker. Nothing the
    // company does to its audience lifts the hold; only an admin's `on` does (#2891).
    await companyForm.updateForPayer(
      out.posting_id,
      out.company_id,
      { audience: "badabhai_workers" },
      CTX,
    );
    const [kept] = await client.db
      .select({ audience: jobPostings.audience })
      .from(jobPostings)
      .where(eq(jobPostings.id, out.posting_id));
    expect(kept?.audience).toBe("badabhai_workers");
    expect(await workerJobs.findWorkerVisibleJobById(out.posting_id)).toBeUndefined();
  });

  it("refuses to post for a company Campus did not create, and never finds it", async () => {
    const phone = phone10();
    const own = await new PayersRepository(client.db, pii).createOrGet({
      role: "employer",
      phone: `+91${phone}`,
      orgName: `Own Co ${TAG}`,
    });
    touchedPayers.push(own.id);

    expect(
      await refusalCode(
        campusPostings.postForCompany(
          {
            company: { phone, name: "Any Name" },
            title: "CNC Operator",
            description: "",
            city: "Faridabad",
            openings: 1,
            branch_ids: [],
            course_ids: [],
            staff_ref: STAFF,
          },
          CTX,
        ),
      ),
    ).toBe("COMPANY_NOT_CAMPUS_CREATED");
    expect(await campusPostings.findCompany(phone)).toBeNull();
  });

  // ── #2753 item 8 — the worker side of a Campus application ──────────────────────────────────

  /** The student a Campus application linked: the Campus record names him. */
  async function studentOf(externalRef: string): Promise<string> {
    const [row] = await client.db
      .select({ workerId: instituteApplications.workerId })
      .from(instituteApplications)
      .where(eq(instituteApplications.externalRef, externalRef));
    return row!.workerId;
  }

  /** His own worker-app apply on a posting for everyone, as the V1 apply writes it. */
  async function appliedInApp(workerId: string, postingId: string): Promise<void> {
    await client.db.insert(applications).values({
      jobPostingId: postingId,
      workerId,
      action: "applied",
      sourceSurface: "feed",
      rank: 1,
    });
  }

  const myApplications = async (workerId: string) =>
    (await workerApps.applicationsForWorker(workerId)).applications;

  it("#2753 — lists a Campus application in the student's own list, in the row every application has", async () => {
    const campusPosting = await posting("rvm_students");
    await approve(campusPosting);
    const app = await applied(campusPosting);
    const workerId = await studentOf(app.externalRef);
    const appPosting = await posting("both");
    await appliedInApp(workerId, appPosting);

    const mine = await myApplications(workerId);

    // Nothing filters it out: not the posting's audience (RVM students only), not its kind, not
    // the `other` surface a Campus apply records.
    const campus = mine.find((a) => a.job_id === campusPosting);
    const own = mine.find((a) => a.job_id === appPosting);
    expect(campus).toMatchObject({
      job_id: campusPosting,
      trade_key: null,
      title: "CNC Operator",
      city: null,
      area: null,
      action: "applied",
      reason: null,
      source_surface: "other",
      rank: null,
      matched_skill_label: null,
    });
    // No field of its own: the keys of his app application, so a shipped build decodes it. The
    // one additive key, `via`, is on both and tells them apart.
    expect(own).toBeDefined();
    expect(Object.keys(campus!).sort()).toEqual(Object.keys(own!).sort());
    expect([campus!.via, own!.via]).toEqual(["campus", "app"]);
  });

  it("#2753 — the worker-side walk: his list says campus, the company sees an RVM student, a withdrawal takes it off both", async () => {
    const postingId = await posting("rvm_students");
    await approve(postingId);
    const app = await applied(postingId);
    const workerId = await studentOf(app.externalRef);

    expect((await myApplications(workerId)).map((a) => [a.job_id, a.action, a.via])).toEqual([
      [postingId, "applied", "campus"],
    ]);
    const listed = await companyList.listForOwned(postingId, companyId, CTX);
    expect(listed.applicants).toHaveLength(1);
    expect(listed.applicants[0]).toMatchObject({ workerId, source: "rvm_student" });

    await campusApps.withdraw(app.externalRef, CTX);

    // The same as an application that no longer exists: no row, no residue, on either list.
    expect(await myApplications(workerId)).toEqual([]);
    expect((await companyList.listForOwned(postingId, companyId, CTX)).applicants).toEqual([]);
  });

  it("#2753 — an app apply Campus also records reads app, before and after the Campus withdrawal", async () => {
    // A first Campus application links him; he then applies in the app to a posting for everyone,
    // and Campus sends the same apply: the Campus record points at HIS row and does not own it.
    const first = await posting("rvm_students");
    await approve(first);
    const linked = await applied(first);
    const workerId = await studentOf(linked.externalRef);
    const both = await posting("both");
    await approve(both);
    await appliedInApp(workerId, both);
    const externalRef = `campus-app-${randomUUID().slice(0, 12)}`;
    const out = await campusApps.apply(
      { external_ref: externalRef, posting_id: both, student_ref: linked.studentRef },
      CTX,
    );
    expect(out.created).toBe(true);
    const viaOf = async () => (await myApplications(workerId)).find((a) => a.job_id === both)?.via;

    // `via` names who created it: he did, in the app. The live Campus record does not own it.
    expect(await viaOf()).toBe("app");
    await campusApps.withdraw(externalRef, CTX);
    // His own application stays on his list, still his own.
    expect(await viaOf()).toBe("app");
  });
});
