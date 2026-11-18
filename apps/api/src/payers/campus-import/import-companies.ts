/**
 * #2754 item 6 — place each Campus company on a BadaBhai account.
 *
 * ONE TRANSACTION PER COMPANY. The account, its profile, its phone proof, the test mark and the
 * ledger row commit together or not at all, so a failure part-way leaves no half-made company and
 * the next run simply tries it again.
 *
 * MATCH BEFORE CREATE (never a second account), in this order:
 *   1. the phone the account would hold (E.164 hash on `payers.phone_hash`) — two or more accounts
 *      on that phone already is an EXCEPTION, resolved by hand (`report:shared-payer-phones`);
 *   2. the sign-in e-mail (`payers.email_hash`, unique);
 *   3. the GSTIN (`employer_profiles` / `agency_profiles.gst_number_hash`).
 * A matched account is never changed: no field of it is overwritten. Only its phone proof may be
 * added, when Campus proved the very phone it already holds.
 *
 * CREATE goes through `PayersRepository.createOrGet`, never `PayerAuthService.signup`, so the
 * sign-up grant (`FreeTierService.grantQuietly`) does not fire (#2754 Money defaults). Accounts are
 * created `pending` and become `active` at their first code sign-in, as every account does.
 *
 * NOTHING HERE LOGS A VALUE. Outcomes are ledger rows with ids and reason codes.
 */
import { and, eq } from "drizzle-orm";
import {
  agencyProfiles,
  employerProfiles,
  payers,
  type Database,
  type PayerRole,
} from "@badabhai/db";
import type { EventsService } from "../../events/events.service";
import type { PiiCryptoService } from "../../common/pii-crypto.service";
import type { PayersRepository } from "../payers.repository";
import type { PayerPhoneProofsRepository } from "../payer-phone-proofs.repository";
import { restampCompanyDriveRequests } from "../../campus-drives/campus-drive-feed-stamp";
import type { CampusBundle, CampusCompany } from "./bundle.schema";
import { campusPhoneToE164, decideCompany } from "./mapping";
import { lockRow, writeRow, FINISHED_STATES, type OpenBatch } from "./import-ledger.repository";

const GSTIN_SHAPE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;

export interface CompanyImportDeps {
  db: Database;
  pii: PiiCryptoService;
  payers: PayersRepository;
  phoneProofs: PayerPhoneProofsRepository;
  events: EventsService;
}

export interface CompanyImportOptions {
  /** Campus source ids the placement team named as agencies or contractors: created as `agent`. */
  agentSourceIds: ReadonlySet<string>;
  /** Why the batch's companies are test companies, when the batch is a test (`--test`). */
  testReason: "pilot_test" | "rehearsal" | null;
}

export type CompanyOutcome =
  | "created"
  | "matched"
  | "already_done"
  | "exception";

export interface CompanyImportSummary {
  created: number;
  matched: number;
  alreadyDone: number;
  exceptions: Record<string, number>;
  /** Created or matched companies whose Campus-proven phone could not be recorded, by reason. */
  proofNotRecorded: Record<string, number>;
  /** Campus source id → BadaBhai payer id, for every placed company (this run or an earlier one). */
  placed: Map<string, string>;
}

const bump = (tally: Record<string, number>, key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

function cleanGstin(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, "").toUpperCase();
  return GSTIN_SHAPE.test(v) ? v : null;
}

type Match =
  | { kind: "none" }
  | { kind: "matched"; payerId: string; by: "phone" | "email" | "gstin" }
  | { kind: "exception"; reason: string };

/** Steps 1 to 3 of the match, inside the company's transaction. */
async function findExisting(
  tx: Database,
  pii: PiiCryptoService,
  phone: string | null,
  email: string | null,
  gstin: string | null,
): Promise<Match> {
  if (phone !== null) {
    const rows = await tx
      .select({ id: payers.id })
      .from(payers)
      .where(eq(payers.phoneHash, pii.hashPhone(phone)))
      .limit(2);
    if (rows.length > 1) return { kind: "exception", reason: "phone_shared_on_badabhai" };
    if (rows[0]) return { kind: "matched", payerId: rows[0].id, by: "phone" };
  }
  if (email !== null) {
    const [row] = await tx
      .select({ id: payers.id })
      .from(payers)
      .where(eq(payers.emailHash, pii.hmac(email)))
      .limit(1);
    if (row) return { kind: "matched", payerId: row.id, by: "email" };
  }
  if (gstin !== null) {
    const hash = pii.hashGstin(gstin);
    const employer = await tx
      .select({ id: employerProfiles.payerId })
      .from(employerProfiles)
      .where(eq(employerProfiles.gstNumberHash, hash))
      .limit(2);
    const agency = await tx
      .select({ id: agencyProfiles.payerId })
      .from(agencyProfiles)
      .where(eq(agencyProfiles.gstNumberHash, hash))
      .limit(2);
    const ids = [...new Set([...employer, ...agency].map((r) => r.id))];
    if (ids.length > 1) return { kind: "exception", reason: "gstin_shared_on_badabhai" };
    if (ids[0]) return { kind: "matched", payerId: ids[0], by: "gstin" };
  }
  return { kind: "none" };
}

/** The account's company record: `employer_profiles` for an employer, `agency_profiles` for an agent. */
async function writeProfile(
  tx: Database,
  pii: PiiCryptoService,
  role: PayerRole,
  payerId: string,
  company: CampusCompany,
  verification: "verified" | "pending",
  gstin: string | null,
): Promise<void> {
  const enc = (v: string | null | undefined) => (v ? pii.encrypt(v) : null);
  const city = company.profile.city?.trim() || null;
  const common = {
    payerId,
    website: company.profile.website?.trim() || null,
    verificationStatus: verification,
    gstNumberEnc: gstin ? pii.encrypt(gstin) : null,
    gstNumberHash: gstin ? pii.hashGstin(gstin) : null,
    contactPersonEnc: enc(company.contact.name?.trim()),
    companyEmailEnc: enc(company.contact.email?.trim().toLowerCase()),
    companyPhoneEnc: enc(campusPhoneToE164(company.contact.phone)),
  };
  if (role === "employer") {
    await tx
      .insert(employerProfiles)
      .values({
        ...common,
        industry: company.profile.industry?.trim() || null,
        companySize: company.profile.size?.trim() || null,
        hiringLocations: city ? [city] : [],
      })
      .onConflictDoNothing({ target: employerProfiles.payerId });
    // A new verified company may now stand on Campus's drive feed (#2746 PR 6, owner ruling R2).
    await restampCompanyDriveRequests(tx, payerId);
    return;
  }
  await tx
    .insert(agencyProfiles)
    .values({ ...common, operatingCities: city ? [city] : [] })
    .onConflictDoNothing({ target: agencyProfiles.payerId });
}

/** `--test`: mark the company a test account (#2755), with the same event the admin route emits. */
async function markTest(
  tx: Database,
  events: EventsService,
  payerId: string,
  reason: "pilot_test" | "rehearsal",
  batch: OpenBatch,
): Promise<void> {
  const moved = await tx
    .update(payers)
    .set({ isTestAccount: true, updatedAt: new Date() })
    .where(and(eq(payers.id, payerId), eq(payers.isTestAccount, false)))
    .returning({ id: payers.id });
  if (moved.length === 0) return;
  await events.emit({
    event_name: "admin.payer_test_account_marked",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: payerId },
    payload: { payer_id: payerId, reason, admin_id: null },
    correlationId: batch.id,
    requestId: `campus-import:${batch.batchKey}`,
    idempotencyKey: `admin.payer_test_account_marked:${payerId}:campus-import:${batch.batchKey}`,
    tx,
  });
}

/** One company, in its own transaction. */
async function importOne(
  deps: CompanyImportDeps,
  batch: OpenBatch,
  bundle: CampusBundle,
  company: CampusCompany,
  opts: CompanyImportOptions,
): Promise<{ outcome: CompanyOutcome; payerId: string | null; reason: string | null; proof: string | null }> {
  return deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const prior = await lockRow(tx, "company", company.source_id);
    if (prior && FINISHED_STATES.has(prior.state)) {
      return { outcome: "already_done" as const, payerId: prior.targetId, reason: null, proof: null };
    }

    const decision = decideCompany(company, bundle.logins);
    const ledger = (state: "created" | "matched" | "exception", targetId: string | null, reason: string | null, detail: Record<string, unknown>) =>
      writeRow(tx, {
        batchId: batch.id,
        kind: "company",
        sourceId: company.source_id,
        companySourceId: company.source_id,
        state,
        targetId,
        reason,
        detail,
      });

    if (!decision.move) {
      await ledger("exception", null, decision.reason, {});
      return { outcome: "exception" as const, payerId: null, reason: decision.reason, proof: null };
    }

    const role: PayerRole = opts.agentSourceIds.has(company.source_id) ? "agent" : "employer";
    const gstin = cleanGstin(company.gst?.gstin);
    const match = await findExisting(tx, deps.pii, decision.phone, decision.email, gstin);
    if (match.kind === "exception") {
      await ledger("exception", null, match.reason, {});
      return { outcome: "exception" as const, payerId: null, reason: match.reason, proof: null };
    }

    let payerId: string;
    let outcome: "created" | "matched";
    const detail: Record<string, unknown> = {
      role,
      verification: decision.verification,
      phone: decision.phone === null ? (decision.noPhoneReason ?? "none") : decision.phoneProven ? "proven" : "unproven",
      gstin: company.gst?.gstin ? (gstin ? "stored" : "invalid") : "none",
    };

    if (match.kind === "matched") {
      const [existing] = await tx
        .select({ status: payers.status })
        .from(payers)
        .where(eq(payers.id, match.payerId))
        .limit(1);
      if (existing && (existing.status === "archived" || existing.status === "suspended")) {
        await ledger("exception", null, `matched_account_${existing.status}`, { matched_by: match.by });
        return { outcome: "exception" as const, payerId: null, reason: `matched_account_${existing.status}`, proof: null };
      }
      payerId = match.payerId;
      outcome = "matched";
      detail.matched_by = match.by;
    } else {
      const created = await deps.payers.createOrGet(
        {
          role,
          orgName: company.name.trim(),
          ...(decision.email ? { email: decision.email } : {}),
          ...(decision.phone ? { phone: decision.phone } : {}),
        },
        tx,
      );
      payerId = created.id;
      outcome = created.created ? "created" : "matched";
      if (created.created) {
        await writeProfile(tx, deps.pii, role, payerId, company, decision.verification, gstin);
      } else {
        detail.matched_by = "contact_on_create";
      }
    }

    // Campus proved this phone by its own OTP (`app_users.phone`, Prakash 17 Nov). Record it only on
    // the phone the account holds now; a proof another account holds is listed, never forced.
    let proof: string | null = null;
    if (decision.phone !== null && decision.phoneProven) {
      const written = await deps.phoneProofs.recordImportedProof(payerId, deps.pii.hashPhone(decision.phone), tx);
      proof = written;
      detail.proof = written;
    }

    if (batch.isTest && opts.testReason !== null) {
      await markTest(tx, deps.events, payerId, opts.testReason, batch);
      detail.test = opts.testReason;
    }

    const reason = proof !== null && proof !== "proven" ? `proof_${proof}` : null;
    await ledger(outcome, payerId, reason, detail);
    return { outcome, payerId, reason: null, proof };
  });
}

/** Place every company of the bundle, one transaction each. Returns counts and the id map. */
export async function importCompanies(
  deps: CompanyImportDeps,
  batch: OpenBatch,
  bundle: CampusBundle,
  opts: CompanyImportOptions,
): Promise<CompanyImportSummary> {
  const summary: CompanyImportSummary = {
    created: 0,
    matched: 0,
    alreadyDone: 0,
    exceptions: {},
    proofNotRecorded: {},
    placed: new Map(),
  };
  for (const company of bundle.companies) {
    const r = await importOne(deps, batch, bundle, company, opts);
    if (r.payerId !== null && r.outcome !== "exception") summary.placed.set(company.source_id, r.payerId);
    if (r.outcome === "created") summary.created += 1;
    else if (r.outcome === "matched") summary.matched += 1;
    else if (r.outcome === "already_done") summary.alreadyDone += 1;
    else bump(summary.exceptions, r.reason ?? "unknown");
    if (r.proof !== null && r.proof !== "proven") bump(summary.proofNotRecorded, r.proof);
  }
  return summary;
}
