import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import {
  studentImportBatches,
  studentImportRows,
  studentImportSubjects,
  studentVisibility,
  workerCertificates,
  workerEmployment,
  workerEmploymentRole,
  workerInstituteLinks,
  workerOrigins,
  workerProfiles,
  workers,
  workerSkills,
  readPostingEnabledKinds,
  type Database,
} from "@badabhai/db";
import type { EventsService } from "../events/events.service";
import { recordImportedConsent } from "../student-move/imported-consent";
import { WorkersRepository } from "../workers/workers.repository";
import { StudentImportRepository } from "./student-import.repository";
import { WorkerFieldSourcesRepository } from "../student-move/worker-field-sources";
import type {
  CampusStudentBundle,
  CampusStudentLine,
  ParsedStudentLine,
} from "./campus-student-bundle";
import {
  mapCampusStudentProfile,
  type CampusMappingContext,
  type MappedStudentProfile,
  type UnmappedField,
  type UnmappedReason,
} from "./campus-profile-mapping";

/**
 * #2887 step 3 — importing Campus's student export into BadaBhai (ADR-0067).
 *
 * ONE STUDENT, ONE TRANSACTION. Each student is decided from what BadaBhai already holds (the
 * ledger's subject for his Campus id, the worker on his phone), then written in its own
 * transaction with his ledger row. A failure rolls back that student only and is a `failed`
 * ledger row with a reason code; the run goes on.
 *
 * WHAT IS HELD (a `held` ledger row, nothing else written):
 *   - his phone is not a usable mobile of his own (`phone_missing`, `phone_not_mobile`,
 *     `phone_shared`, `phone_company_number`) — one phone is one person, the placement team
 *     resolves those first;
 *   - Campus says he is under 18 (`under_18`);
 *   - his phone already belongs to a BadaBhai worker the import did not create
 *     (`already_badabhai_worker`): an existing worker is never hidden or overwritten;
 *   - his phone belongs to another moved student (`phone_shared`), or his phone changed on Campus
 *     since he was moved (`phone_changed`): a login never moves without the person.
 *
 * A NEW STUDENT becomes a `pending` worker (no `worker.created`, no welcome, no grant: his first
 * sign-in activates the row), with origin institute/rvm, his institute link when Campus sent a
 * student reference, his profile, an ACTIVE consent row from the import (owner ruling; sign-in
 * still asks him BadaBhai's own notice and the 18+ tick once), and his visibility row OFF.
 *
 * A CHANGED STUDENT (same Campus id, new content) gets only the fields nobody marked as his own
 * edit on BadaBhai (`worker_field_sources`), and only on rows the import itself wrote. His consent
 * and visibility are never touched again.
 *
 * Writes nothing in a dry run: the same decisions and mapping, reported.
 *
 * ROLES AND COURSES (#3014) are translated by the one Campus table (pack section 7). The trade
 * release switch (#3002) is read ONCE per run: a role or course whose trade companies cannot post
 * yet is held (reported, no skill). A failed read refuses the run before anything is written.
 */

/** The fields the import may write, as admin-override fact keys (the marker's vocabulary). */
export const IMPORT_FIELD_KEYS = [
  "current_city",
  "role",
  "skills",
  "experience",
  "work_history",
  "certifications",
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];

/** Encryption and phone hashing, as PiiCryptoService does them. */
export interface ImportCrypto {
  encrypt(plaintext: string): string;
  hashPhone(phoneE164: string): string;
}

export type StudentAction = "created" | "updated" | "unchanged" | "held" | "failed";

export interface StudentOutcome {
  readonly sourceId: string;
  readonly action: StudentAction;
  readonly reason: string | null;
  readonly workerId: string | null;
  readonly fieldsWritten: readonly string[];
}

export interface ImportReport {
  readonly mode: "dry_run" | "apply";
  readonly batchId: string | null;
  readonly manifest: {
    readonly generatedAt: string;
    readonly scope: unknown;
    readonly nextSince: string | null;
    readonly counts: unknown;
  };
  readonly totals: Record<StudentAction, number> & { readonly lineErrors: number };
  readonly heldByReason: Record<string, number>;
  readonly failedByReason: Record<string, number>;
  readonly problemsByKind: Record<string, number>;
  /** The values the owner rules on: each unmapped value and how many students carry it. */
  readonly unmapped: readonly {
    readonly field: UnmappedField;
    readonly value: string;
    readonly reason: UnmappedReason;
    readonly students: number;
  }[];
  /** Roles and courses ruled "label only" (no skill, not held), with how many students. */
  readonly labelOnly: readonly {
    readonly field: "job_role" | "course";
    readonly value: string;
    readonly students: number;
  }[];
  readonly lineErrors: readonly {
    line: number;
    sourceId: string | null;
    issues: readonly string[];
  }[];
  /** Ids only: never a name or a phone. */
  readonly students: readonly StudentOutcome[];
}

export interface ImportOptions {
  readonly apply: boolean;
  /** The ledger label; required to apply. */
  readonly batchLabel: string | null;
  /** A `--since` run: the manifest must say so, and the batch records it. */
  readonly since: boolean;
  readonly limit?: number;
  readonly now?: Date;
  /** The release switch, when the caller already read it; read from the database otherwise. */
  readonly postingEnabled?: ReadonlySet<string>;
}

/** Refused before anything is read or written. */
export class StudentImportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudentImportRefused";
  }
}

/** The pure part of the decision: why a line is held whatever BadaBhai holds, or null. */
export function holdReasonFor(student: CampusStudentLine): string | null {
  switch (student.phone.class) {
    case "missing":
      return "phone_missing";
    case "not_mobile":
      return "phone_not_mobile";
    case "shared":
      return "phone_shared";
    case "company_number":
      return "phone_company_number";
    case "good":
      break;
  }
  if (student.phone.value === null) return "phone_missing";
  if (student.adult === false) return "under_18";
  return null;
}

/** What BadaBhai already holds for one line. */
export interface StudentState {
  /** The ledger's subject for his Campus id. */
  readonly subject: { readonly workerId: string; readonly contentHash: string } | null;
  /** The worker on his phone. */
  readonly workerOnPhone: { readonly id: string } | null;
  /** Whether a subject (any Campus id) already maps to that worker. */
  readonly workerOnPhoneHasSubject: boolean;
}

export type StudentDecision =
  | { readonly kind: "held"; readonly reason: string; readonly workerId: string | null }
  | { readonly kind: "create" }
  | { readonly kind: "update"; readonly workerId: string }
  | { readonly kind: "unchanged"; readonly workerId: string };

/** Decides one line from what BadaBhai holds. Pure: exported for the tests. */
export function decideStudent(line: ParsedStudentLine, state: StudentState): StudentDecision {
  const hold = holdReasonFor(line.student);
  if (hold) return { kind: "held", reason: hold, workerId: state.subject?.workerId ?? null };
  if (state.subject) {
    if (state.workerOnPhone === null) {
      return { kind: "held", reason: "phone_changed", workerId: state.subject.workerId };
    }
    if (state.workerOnPhone.id !== state.subject.workerId) {
      return { kind: "held", reason: "phone_shared", workerId: state.subject.workerId };
    }
    if (state.subject.contentHash === line.contentHash) {
      return { kind: "unchanged", workerId: state.subject.workerId };
    }
    return { kind: "update", workerId: state.subject.workerId };
  }
  if (state.workerOnPhone) {
    return {
      kind: "held",
      reason: state.workerOnPhoneHasSubject ? "phone_shared" : "already_badabhai_worker",
      workerId: null,
    };
  }
  return { kind: "create" };
}

/** A Campus consent text version as `recordImportedConsent` accepts it. */
export function campusConsentVersionOf(student: CampusStudentLine): {
  version: string;
  givenAt: Date | null;
} {
  const records = (student.consent?.campus_records ?? [])
    .filter((r) => typeof r.text_version === "string" && r.text_version.trim().length > 0)
    .map((r) => ({ version: r.text_version!.trim(), at: r.given_at ? new Date(r.given_at) : null }))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const newest = records[0];
  const raw = newest?.version ?? "bulk_move_ruling";
  const version = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const givenAt = newest?.at && !Number.isNaN(newest.at.getTime()) ? newest.at : null;
  return { version: version.length > 0 ? version : "bulk_move_ruling", givenAt };
}

function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/\s+/g, " ");
  return v.length > 0 ? v.slice(0, max) : null;
}

/** "2024-01-31" → "2024-01"; anything else → null. */
function ymOf(value: string | null | undefined): string | null {
  const m = typeof value === "string" ? /^(\d{4})-(0[1-9]|1[0-2])/.exec(value.trim()) : null;
  return m ? `${m[1]}-${m[2]}` : null;
}

/** The student's own skill and software names, as his profile shows them (at most 30). */
function profileSkillNames(student: CampusStudentLine): string[] {
  const out = new Map<string, string>();
  for (const name of [
    ...(student.profile?.cad_software ?? []),
    ...(student.profile?.skills ?? []),
  ]) {
    const v = clean(name, 80);
    if (v && !out.has(v.toLowerCase())) out.set(v.toLowerCase(), v);
  }
  return [...out.values()].slice(0, 30);
}

/** Employment rows from the student's own experience (RVM's course row is training, not a job). */
function employmentRows(student: CampusStudentLine): {
  company: string;
  role: string | null;
  startYm: string | null;
  endYm: string | null;
}[] {
  return (student.experience ?? [])
    .filter((row) => row.source !== "rvm_training")
    .flatMap((row) => {
      const company = clean(row.company_name, 120);
      if (!company) return [];
      const startYm = ymOf(row.start_date);
      let endYm = row.is_current === true ? null : ymOf(row.end_date);
      if (startYm && endYm && endYm < startYm) endYm = null;
      return [{ company, role: clean(row.job_role, 80), startYm, endYm }];
    })
    .slice(0, 20);
}

const PROFILE_MARK = "campus";

interface WriteContext {
  readonly db: Database;
  readonly crypto: ImportCrypto;
  readonly sources: WorkerFieldSourcesRepository;
  readonly batchId: string;
  readonly manifestGeneratedAt: Date | null;
  readonly now: Date;
  readonly mapping: CampusMappingContext;
}

/** Writes one new student. Returns the new worker id and the fields written. */
async function createStudent(
  tx: Database,
  ctx: WriteContext,
  line: ParsedStudentLine,
  mapped: MappedStudentProfile,
): Promise<{ workerId: string; fields: string[] }> {
  const s = line.student;
  const phoneE164 = `+91${s.phone.value!}`;
  const name = clean(s.name, 120);
  const city = clean(s.city, 80);
  // The one race-safe worker insert (a `pending` row: his own OTP sign-in activates it). A row
  // someone else created on this phone since the run read it is not his to take: fail the line.
  const { worker, created } = await new WorkersRepository(ctx.db).createOrGetByPhoneHash(
    {
      phoneE164: ctx.crypto.encrypt(phoneE164),
      phoneHash: ctx.crypto.hashPhone(phoneE164),
      fullName: name ? ctx.crypto.encrypt(name) : null,
      currentCity: city,
      status: "pending",
    },
    tx,
  );
  if (!created) throw new ImportStepError("phone_race");
  const workerId = worker.id;

  await tx
    .insert(workerOrigins)
    .values({ workerId, kind: "institute", ref: "rvm" })
    .onConflictDoNothing();

  const studentRef = clean(s.student_ref, 128)?.toLowerCase() ?? null;
  const course = clean(s.rvm?.course, 200);
  const branch = clean(s.rvm?.branch?.name, 200);
  const studentStatus =
    s.rvm?.status === "current"
      ? "current_student"
      : s.rvm?.status === "alumnus"
        ? "alumnus"
        : null;
  if (studentRef && course && branch && studentStatus) {
    await tx
      .insert(workerInstituteLinks)
      .values({
        workerId,
        instituteCode: "rvm",
        studentRef,
        status: "active",
        studentStatus,
        course,
        branch,
        linkedAt: ctx.now,
        syncedAt: ctx.now,
      })
      .onConflictDoNothing();
  }

  const fields = await writeProfile(
    tx,
    ctx,
    workerId,
    line,
    mapped,
    new Set(IMPORT_FIELD_KEYS),
    true,
  );

  const consent = campusConsentVersionOf(s);
  await recordImportedConsent(tx, workerId, {
    campusConsentVersion: consent.version,
    campusConsentedAt: consent.givenAt ?? ctx.manifestGeneratedAt ?? ctx.now,
  });

  await tx
    .insert(studentVisibility)
    .values({ workerId, visible: false, batchId: ctx.batchId })
    .onConflictDoNothing();
  return { workerId, fields };
}

/**
 * Writes the profile fields in `allowed`. On an update (`fresh` false) only the profile row the
 * import itself wrote is touched; a profile the worker built on BadaBhai is never rewritten.
 */
async function writeProfile(
  tx: Database,
  ctx: WriteContext,
  workerId: string,
  line: ParsedStudentLine,
  mapped: MappedStudentProfile,
  allowed: ReadonlySet<string>,
  fresh: boolean,
): Promise<string[]> {
  const s = line.student;
  const written: string[] = [];
  const city = clean(s.city, 80);
  const roleLabel = clean(s.profile?.job_role, 80);
  const domainLabel = clean(s.profile?.job_domain, 80);
  const totalYears =
    mapped.totalExperienceMonths === null
      ? null
      : Math.round((mapped.totalExperienceMonths / 12) * 10) / 10;

  // The profile row: the import's own (marked in raw_profile), or a new one for a new student.
  const [latest] = await tx
    .select({ id: workerProfiles.id, rawProfile: workerProfiles.rawProfile })
    .from(workerProfiles)
    .where(eq(workerProfiles.workerId, workerId))
    .orderBy(dsql`${workerProfiles.createdAt} DESC`)
    .limit(1);
  const ownsLatest =
    latest !== undefined &&
    (latest.rawProfile as Record<string, unknown> | null)?.import_source === PROFILE_MARK;

  const profileValues = {
    skills: profileSkillNames(s),
    experience: totalYears === null ? {} : { total_years: totalYears },
    rawProfile: {
      import_source: PROFILE_MARK,
      ...(roleLabel ? { role_label: roleLabel } : {}),
      ...(domainLabel ? { domain_label: domainLabel } : {}),
    },
    locationPreference: city ? { current_city: city } : {},
  };

  if (fresh || latest === undefined) {
    await tx.insert(workerProfiles).values({
      workerId,
      profileStatus: "confirmed",
      confirmedAt: ctx.now,
      ...profileValues,
    });
    written.push("role", "skills", "experience");
  } else if (ownsLatest) {
    const set: Partial<typeof workerProfiles.$inferInsert> = {};
    if (allowed.has("skills")) set.skills = profileValues.skills;
    if (allowed.has("experience")) set.experience = profileValues.experience;
    if (allowed.has("role")) set.rawProfile = profileValues.rawProfile;
    if (Object.keys(set).length > 0) {
      await tx.update(workerProfiles).set(set).where(eq(workerProfiles.id, latest.id));
      if (set.skills) written.push("skills");
      if (set.experience) written.push("experience");
      if (set.rawProfile) written.push("role");
    }
  }

  // Match skills: `ops` rows, which a rebuild keeps and the worker's own skill edit clears.
  if (allowed.has("skills")) {
    const ids = mapped.skills.map((m) => m.skillId);
    await tx
      .delete(workerSkills)
      .where(
        and(
          eq(workerSkills.workerId, workerId),
          eq(workerSkills.source, "ops"),
          ids.length > 0
            ? dsql`${workerSkills.skillId} <> ALL(${dsql.param(ids)}::text[])`
            : undefined,
        ),
      );
    for (const m of mapped.skills) {
      await tx
        .insert(workerSkills)
        .values({
          workerId,
          skillId: m.skillId,
          industryId: m.industryId,
          monthsBucketed: m.monthsBucketed,
          wants: true,
          source: "ops",
          updatedAt: ctx.now,
        })
        .onConflictDoUpdate({
          target: [workerSkills.workerId, workerSkills.skillId],
          set: {
            industryId: m.industryId,
            monthsBucketed: m.monthsBucketed,
            wants: true,
            source: "ops",
            updatedAt: ctx.now,
          },
          setWhere: dsql`${workerSkills.source} IN ('ops', 'derived_coarse')`,
        });
    }
    if (!written.includes("skills")) written.push("skills");
  }

  if (allowed.has("certifications")) {
    await tx.delete(workerCertificates).where(eq(workerCertificates.workerId, workerId));
    let order = 0;
    for (const c of mapped.certificates) {
      await tx.insert(workerCertificates).values({
        workerId,
        name: c.name,
        issuer: c.issuer,
        year: c.year,
        sortOrder: order++,
      });
    }
    written.push("certifications");
  }

  if (allowed.has("work_history")) {
    await tx.delete(workerEmployment).where(eq(workerEmployment.workerId, workerId));
    let order = 0;
    for (const e of employmentRows(s)) {
      const [job] = await tx
        .insert(workerEmployment)
        .values({
          workerId,
          employerNameEnc: ctx.crypto.encrypt(e.company),
          startYm: e.startYm,
          endYm: e.endYm,
          durationStated: e.startYm !== null,
          sortOrder: order++,
        })
        .returning({ id: workerEmployment.id });
      if (job && e.role) {
        await tx.insert(workerEmploymentRole).values({
          employmentId: job.id,
          roleLabel: e.role,
          startYm: e.startYm,
          endYm: e.endYm,
          sortOrder: 0,
        });
      }
    }
    written.push("work_history");
  }

  if (!fresh && allowed.has("current_city") && city) {
    await tx.update(workers).set({ currentCity: city }).where(eq(workers.id, workerId));
    written.push("current_city");
  } else if (fresh && city) {
    written.push("current_city");
  }

  const unique = [...new Set(written)];
  await ctx.sources.markImported(tx, workerId, unique, ctx.batchId);
  return unique;
}

/** A step failed for a known reason: the student is a `failed` row with this code. */
class ImportStepError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImportStepError";
  }
}

async function tablesPresent(db: Database): Promise<boolean> {
  const rows = (await db.execute(
    dsql`SELECT to_regclass('public.student_import_batches') IS NOT NULL AS present`,
  )) as unknown as { present?: unknown }[];
  return rows[0]?.present === true;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Imports (or, in a dry run, plans) every student line of a bundle. */
export async function importCampusStudents(
  db: Database,
  crypto: ImportCrypto,
  bundle: CampusStudentBundle,
  opts: ImportOptions,
): Promise<ImportReport> {
  const now = opts.now ?? new Date();
  const scope = bundle.manifest.scope as { students: string; since?: string };
  if (opts.since && scope.students !== "since") {
    throw new StudentImportRefused("--since given, but the bundle is not a since export");
  }
  if (!opts.since && scope.students === "since") {
    throw new StudentImportRefused("the bundle is a since export: run it with --since");
  }
  const present = await tablesPresent(db);
  if (opts.apply) {
    if (!present) throw new StudentImportRefused("the 0182 student-move tables are missing");
    if (!opts.batchLabel) throw new StudentImportRefused("--apply needs --batch <label>");
  }

  // Read once, before any write: a failed read throws here and the run writes nothing.
  const mapping: CampusMappingContext = {
    postingEnabled: opts.postingEnabled ?? (await readPostingEnabledKinds(db)),
  };

  const lines = bundle.students.slice(0, opts.limit ?? bundle.students.length);
  const sources = new WorkerFieldSourcesRepository(db);
  const generatedAt = new Date(bundle.manifest.generated_at);
  const manifestGeneratedAt = Number.isNaN(generatedAt.getTime()) ? null : generatedAt;

  let batchId: string | null = null;
  if (opts.apply) {
    const [batch] = await db
      .insert(studentImportBatches)
      .values({
        source: "campus",
        label: opts.batchLabel!.slice(0, 120),
        since: opts.since && scope.since ? new Date(scope.since) : null,
        status: "running",
      })
      .returning({ id: studentImportBatches.id });
    batchId = batch!.id;
  }

  // What BadaBhai already holds, read once for the whole run.
  const sourceIds = lines.map((l) => l.student.source_id);
  const subjects = new Map<string, { workerId: string; contentHash: string }>();
  const workersWithSubject = new Set<string>();
  if (present && sourceIds.length > 0) {
    const rows = await db
      .select({
        sourceId: studentImportSubjects.sourceId,
        workerId: studentImportSubjects.workerId,
        contentHash: studentImportSubjects.contentHash,
      })
      .from(studentImportSubjects)
      .where(
        and(
          eq(studentImportSubjects.source, "campus"),
          inArray(studentImportSubjects.sourceId, sourceIds),
        ),
      );
    for (const r of rows)
      subjects.set(r.sourceId, { workerId: r.workerId, contentHash: r.contentHash });
  }
  const phoneHashes = new Map<string, string>();
  for (const l of lines) {
    if (l.student.phone.value)
      phoneHashes.set(l.student.source_id, crypto.hashPhone(`+91${l.student.phone.value}`));
  }
  const byHash = new Map<string, string>();
  const hashes = [...new Set(phoneHashes.values())];
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    const rows = await db
      .select({ id: workers.id, phoneHash: workers.phoneHash })
      .from(workers)
      .where(inArray(workers.phoneHash, chunk));
    for (const r of rows) byHash.set(r.phoneHash, r.id);
  }
  if (present && byHash.size > 0) {
    const ids = [...byHash.values()];
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await db
        .select({ workerId: studentImportSubjects.workerId })
        .from(studentImportSubjects)
        .where(inArray(studentImportSubjects.workerId, ids.slice(i, i + 500)));
      for (const r of rows) workersWithSubject.add(r.workerId);
    }
  }

  const outcomes: StudentOutcome[] = [];
  const unmapped = new Map<
    string,
    { field: UnmappedField; value: string; reason: UnmappedReason; students: Set<string> }
  >();
  const labelOnly = new Map<
    string,
    { field: "job_role" | "course"; value: string; students: Set<string> }
  >();
  const ctx: WriteContext | null = batchId
    ? { db, crypto, sources, batchId, manifestGeneratedAt, now, mapping }
    : null;

  for (const line of lines) {
    const s = line.student;
    const hash = phoneHashes.get(s.source_id);
    const onPhone = hash ? byHash.get(hash) : undefined;
    const decision = decideStudent(line, {
      subject: subjects.get(s.source_id) ?? null,
      workerOnPhone: onPhone ? { id: onPhone } : null,
      workerOnPhoneHasSubject: onPhone ? workersWithSubject.has(onPhone) : false,
    });

    if (decision.kind !== "held") {
      const mapped = mapCampusStudentProfile(s, mapping);
      for (const u of mapped.unmapped) {
        const key = `${u.field}|${u.value.toLowerCase()}`;
        const entry = unmapped.get(key) ?? {
          field: u.field,
          value: u.value,
          reason: u.reason,
          students: new Set(),
        };
        entry.students.add(s.source_id);
        unmapped.set(key, entry);
      }
      for (const l of mapped.labelOnly) {
        const key = `${l.field}|${l.value.toLowerCase()}`;
        const entry = labelOnly.get(key) ?? { field: l.field, value: l.value, students: new Set() };
        entry.students.add(s.source_id);
        labelOnly.set(key, entry);
      }
    }

    if (!ctx) {
      outcomes.push(plannedOutcome(s.source_id, decision));
      continue;
    }
    outcomes.push(await applyOne(ctx, line, decision));
  }

  const totals = {
    created: 0,
    updated: 0,
    unchanged: 0,
    held: 0,
    failed: 0,
    lineErrors: bundle.lineErrors.length,
  };
  const heldByReason: Record<string, number> = {};
  const failedByReason: Record<string, number> = {};
  for (const o of outcomes) {
    totals[o.action] += 1;
    if (o.action === "held" && o.reason) bump(heldByReason, o.reason);
    if (o.action === "failed" && o.reason) bump(failedByReason, o.reason);
  }
  const problemsByKind: Record<string, number> = {};
  for (const p of bundle.problems) bump(problemsByKind, p.kind);

  if (batchId) {
    await db
      .update(studentImportBatches)
      .set({
        status: totals.failed > 0 && totals.created + totals.updated === 0 ? "failed" : "applied",
        counts: { ...totals, held_by_reason: heldByReason, failed_by_reason: failedByReason },
        finishedAt: new Date(),
      })
      .where(eq(studentImportBatches.id, batchId));
  }

  return {
    mode: opts.apply ? "apply" : "dry_run",
    batchId,
    manifest: {
      generatedAt: bundle.manifest.generated_at,
      scope: bundle.manifest.scope,
      nextSince: bundle.manifest.next_since ?? null,
      counts: bundle.manifest.counts,
    },
    totals,
    heldByReason,
    failedByReason,
    problemsByKind,
    unmapped: [...unmapped.values()]
      .map((u) => ({ field: u.field, value: u.value, reason: u.reason, students: u.students.size }))
      .sort(
        (a, b) =>
          b.students - a.students ||
          a.field.localeCompare(b.field) ||
          a.value.localeCompare(b.value),
      ),
    labelOnly: [...labelOnly.values()]
      .map((l) => ({ field: l.field, value: l.value, students: l.students.size }))
      .sort(
        (a, b) =>
          b.students - a.students ||
          a.field.localeCompare(b.field) ||
          a.value.localeCompare(b.value),
      ),
    lineErrors: bundle.lineErrors.map((e) => ({
      line: e.lineNo,
      sourceId: e.sourceId,
      issues: e.issues,
    })),
    students: outcomes,
  };
}

function plannedOutcome(sourceId: string, d: StudentDecision): StudentOutcome {
  switch (d.kind) {
    case "held":
      return {
        sourceId,
        action: "held",
        reason: d.reason,
        workerId: d.workerId,
        fieldsWritten: [],
      };
    case "create":
      return { sourceId, action: "created", reason: null, workerId: null, fieldsWritten: [] };
    case "update":
      return { sourceId, action: "updated", reason: null, workerId: d.workerId, fieldsWritten: [] };
    case "unchanged":
      return {
        sourceId,
        action: "unchanged",
        reason: null,
        workerId: d.workerId,
        fieldsWritten: [],
      };
  }
}

async function ledgerRow(
  executor: Database,
  batchId: string,
  o: StudentOutcome,
  workerCreated: boolean,
): Promise<void> {
  await executor.insert(studentImportRows).values({
    batchId,
    sourceId: o.sourceId,
    workerId: o.workerId,
    action: o.action,
    reason: o.reason,
    workerCreated,
    fieldsWritten: [...o.fieldsWritten],
  });
}

async function applyOne(
  ctx: WriteContext,
  line: ParsedStudentLine,
  decision: StudentDecision,
): Promise<StudentOutcome> {
  const sourceId = line.student.source_id;
  if (decision.kind === "held" || decision.kind === "unchanged") {
    const o = plannedOutcome(sourceId, decision);
    await ledgerRow(ctx.db, ctx.batchId, o, false);
    return o;
  }
  try {
    return await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const mapped = mapCampusStudentProfile(line.student, ctx.mapping);
      let workerId: string;
      let fields: string[];
      if (decision.kind === "create") {
        ({ workerId, fields } = await createStudent(tx, ctx, line, mapped));
      } else {
        workerId = decision.workerId;
        const allowed = await ctx.sources.importableFields(workerId, IMPORT_FIELD_KEYS, tx);
        fields = await writeProfile(tx, ctx, workerId, line, mapped, allowed, false);
      }
      await tx
        .insert(studentImportSubjects)
        .values({
          source: "campus",
          sourceId,
          workerId,
          firstBatchId: ctx.batchId,
          lastBatchId: ctx.batchId,
          contentHash: line.contentHash,
        })
        .onConflictDoUpdate({
          target: [studentImportSubjects.source, studentImportSubjects.sourceId],
          set: {
            lastBatchId: ctx.batchId,
            contentHash: line.contentHash,
            lastImportedAt: new Date(),
          },
        });
      const o: StudentOutcome = {
        sourceId,
        action: decision.kind === "create" ? "created" : "updated",
        reason: null,
        workerId,
        fieldsWritten: fields,
      };
      await ledgerRow(tx, ctx.batchId, o, decision.kind === "create");
      return o;
    });
  } catch (err) {
    const code = err instanceof ImportStepError ? err.code : "write_failed";
    // Ids and the code only: the error text may carry a value from the line.
    console.warn(
      `[student-import] ${sourceId} failed (${code}${
        err instanceof ImportStepError ? "" : `, ${err instanceof Error ? err.name : "unknown"}`
      })`,
    );
    const o: StudentOutcome = {
      sourceId,
      action: "failed",
      reason: code,
      workerId: null,
      fieldsWritten: [],
    };
    await ledgerRow(ctx.db, ctx.batchId, o, false);
    return o;
  }
}

export interface RollbackReport {
  readonly batchId: string;
  readonly alreadyRolledBack: boolean;
  /** Created workers removed (never signed in). */
  readonly removed: number;
  /** Created workers kept because they signed in since (ids). */
  readonly keptSignedIn: readonly string[];
  /** Updated students: their changes are not reverted (ids). */
  readonly notReverted: readonly string[];
}

/**
 * Undoes one run as far as is safe: every worker THAT RUN CREATED who has still never signed in
 * (`pending`) is deleted (his profile, consent, markers, subject and visibility go with him).
 * A worker who signed in since is a person using BadaBhai and is kept; an updated student's
 * changes are reported, not reverted. Idempotent.
 */
export async function rollbackStudentImport(
  db: Database,
  batchId: string,
  events: Pick<EventsService, "emit">,
): Promise<RollbackReport> {
  if (!(await tablesPresent(db))) {
    throw new StudentImportRefused("the 0182 student-move tables are missing");
  }
  const [batch] = await db
    .select({ id: studentImportBatches.id, status: studentImportBatches.status })
    .from(studentImportBatches)
    .where(eq(studentImportBatches.id, batchId));
  if (!batch) throw new StudentImportRefused(`no import batch ${batchId}`);
  if (batch.status === "rolled_back") {
    return { batchId, alreadyRolledBack: true, removed: 0, keptSignedIn: [], notReverted: [] };
  }
  const rows = await db
    .select({
      id: studentImportRows.id,
      workerId: studentImportRows.workerId,
      action: studentImportRows.action,
      workerCreated: studentImportRows.workerCreated,
    })
    .from(studentImportRows)
    .where(eq(studentImportRows.batchId, batchId));

  const deleter = new StudentImportRepository();
  let removed = 0;
  const keptSignedIn: string[] = [];
  const notReverted: string[] = [];
  for (const row of rows) {
    if (row.action === "updated" && row.workerId) notReverted.push(row.workerId);
    if (!(row.action === "created" && row.workerCreated && row.workerId)) continue;
    const workerId = row.workerId;
    const gone = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const [w] = await tx
        .select({ status: workers.status })
        .from(workers)
        .where(eq(workers.id, workerId))
        .for("update");
      if (!w) return true;
      if (!(await deleter.deleteImportCreatedPendingWorker(tx, workerId, batchId))) return false;
      // #2753 item 13 — every path that erases a workers row writes ONE `worker.account_deleted`,
      // on the delete's own transaction. Counts are the deleter's own predicate: no PIN, no
      // device, and a never-used row has no session or file.
      await events.emit({
        event_name: "worker.account_deleted",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          sessions_revoked: 0,
          devices_revoked: 0,
          storage_objects_deleted: 0,
          storage_objects_failed: 0,
          had_pin: false,
        },
        idempotencyKey: `worker.account_deleted:${workerId}`,
        correlationId: randomUUID(),
        tx,
      });
      return true;
    });
    if (gone) {
      removed += 1;
      await db
        .update(studentImportRows)
        .set({ action: "rolled_back" })
        .where(eq(studentImportRows.id, row.id));
    } else {
      keptSignedIn.push(workerId);
    }
  }
  await db
    .update(studentImportBatches)
    .set({ status: "rolled_back", rolledBackAt: new Date() })
    .where(eq(studentImportBatches.id, batchId));
  return { batchId, alreadyRolledBack: false, removed, keptSignedIn, notReverted };
}
