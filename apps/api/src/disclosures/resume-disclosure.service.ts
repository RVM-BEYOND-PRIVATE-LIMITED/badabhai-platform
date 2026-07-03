import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { DisclosureDenyReason } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { StorageService } from "../storage/storage.service";
import { ResumeRenderer } from "../resume/resume-renderer.service";
import { buildResumeRenderInput } from "../resume/resume-render-input";
import { maskInitials } from "../resume/mask-initials";
import { neutralUnavailable, type NeutralUnavailableResponse } from "../unlocks/unlock-response";
import { ResumeDisclosureRepository, type Tx } from "./resume-disclosure.repository";

/** The disclosure consent purpose this gate keys on (DISTINCT from profiling). */
const EMPLOYER_SHARING = "employer_sharing";

/** The ONE distinguishable success: the payer got the masked resume link. PII-free. */
export interface DisclosureGrantedResponse {
  readonly ok: true;
  readonly disclosure_id: string;
  readonly status: "disclosed";
  /** Short-TTL, server-minted signed URL to the MASKED PDF. NEVER logged/evented (B-D). */
  readonly resume_url: string;
  readonly expires_at: string;
}

/** Either the one distinguishable success, or the byte-identical neutral body (B-C). */
type DisclosureOutcome = DisclosureGrantedResponse | NeutralUnavailableResponse;

/** Internal plan returned by the locked tx: render a fresh grant, reuse, or deny. */
type DisclosurePlan =
  | { kind: "neutral" }
  | { kind: "render"; disclosureId: string }
  | { kind: "reuse"; disclosureId: string; objectKey: string; expiresAt: Date };

/**
 * ResumeDisclosureService — the SINGLE fail-closed chokepoint for handing a payer a
 * worker's EMPLOYER-facing resume (ADR-0013 Decision C; the resume-disclosure
 * threat-model addendum). Reuses the ADR-0010 unlock spine: the same
 * `employer_sharing` consent gate (B-A), the same per-worker advisory lock + a SHARED
 * cap that spans unlock reveals AND disclosures (B-B), the same single neutral-response
 * no-oracle (B-C). It is FREE — there is no payment step.
 *
 * TENANCY (ADR-0027 B5.x Inc 4 — the EXACT sibling of the Inc 2 unlocks flip): OWNERSHIP +
 * the (org, worker, posting) idempotency key on `org_id`, resolved from the acting payer via
 * {@link resolveOrgId} (BEFORE any advisory-locked tx — the deadlock rule) and threaded INTO
 * the tx. The acting `payer_id` stays the event actor/subject UNCHANGED (events + the event
 * schema DO NOT change) and is still stamped on every INSERT (org_id is NOT NULL after
 * migration 0035; payer_id still NOT NULL). A payer acts ONLY within their own org: a
 * foreign-org request/list fails closed into the SAME neutral/empty result (no IDOR, no
 * oracle); two payers in the SAME org share one (org, worker, posting) disclosure. The worker
 * advisory lock (per-worker, IDENTICAL derivation to the unlock lock) and the SHARED per-worker
 * daily ceiling are UNCHANGED — only the distinct-payers WEEKLY cap flips to distinct-org.
 * BEHAVIOR-PRESERVING under today's solo orgs (org == the one payer).
 *
 * FAIL-CLOSED ORDERING (addendum §1; every gate denies + discloses nothing on failure):
 *   [1] employer_sharing consent  → fail → neutral "unavailable" (no oracle)
 *   [2] SHARED worker cap (atomic) → fail → neutral "unavailable"
 *   [3] payment                    → REMOVED (free)
 *   [4] grant resume_disclosures   → status granted
 *   [5] CONTROLLED DISCLOSURE      → render the MASKED resume from the name-free
 *       snapshot with displayName = maskInitials(realName) (B-G), upload, mint a
 *       SHORT-TTL signed URL (B-D), mark disclosed; the real name is read ONCE here,
 *       server-side, and NEVER logged/evented/persisted (F-5).
 *   emit resume.disclosed — the FACT only (ids + opaque resume_ref); NEVER the bytes,
 *       the name, or the signed URL (B-E).
 *
 * NO bulk/list disclosure endpoint exists (B-F): one (payer, worker, posting) per call.
 */
@Injectable()
export class ResumeDisclosureService {
  private readonly logger = new Logger(ResumeDisclosureService.name);

  constructor(
    private readonly repo: ResumeDisclosureRepository,
    private readonly consents: ConsentRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly renderer: ResumeRenderer,
    private readonly storage: StorageService,
    private readonly events: EventsService,
    // ADR-0027 B5.x Inc 4: resolves the OWNING org for an acting payer (the tenancy flip,
    // the EXACT sibling of the Inc 2 unlocks flip).
    private readonly orgs: PayerOrgsRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Resolve the OWNING org for an acting payer (ADR-0027 B5.x Inc 4 — the tenancy pivot,
   * mirroring `UnlockService.resolveOrgId`). Ownership + the (org, worker, posting)
   * idempotency key on `org_id`; the acting `payer_id` stays the event actor/subject
   * unchanged. Returns null when the payer has no active org membership.
   *
   * HOT-PATH DISCIPLINE: uses `resolveOrgForPayer` ONLY (never `ensureSoloOrg`, which
   * writes). It is ALWAYS resolved BEFORE `repo.withTransaction(...)` opens (the pool-vs-lock
   * deadlock rule — the worker advisory lock) and threaded INTO the tx closure, so the
   * advisory-locked tx never needs a second pool connection. FAIL CLOSED: on a null result
   * the CALLER returns the neutral/empty equivalent (no distinguishable error → no oracle);
   * any error → null.
   */
  private async resolveOrgId(payerId: string): Promise<string | null> {
    try {
      return (await this.orgs.resolveOrgForPayer(payerId))?.orgId ?? null;
    } catch {
      return null; // fail closed
    }
  }

  async requestDisclosure(
    input: { payerId: string; workerId: string; jobPostingId: string | null },
    ctx: RequestContext,
  ): Promise<DisclosureOutcome> {
    const { payerId, workerId, jobPostingId } = input;

    // ---- ADR-0027 B5.x Inc 4: resolve the OWNING org BEFORE the tx (deadlock rule) ----
    // Ownership + the (org, worker, posting) idempotency key on `org_id`, resolved from the
    // acting payer here, OUTSIDE (before) `repo.withTransaction`, and threaded INTO the tx
    // closure — never inside the advisory-locked tx (that would need a 2nd pool connection
    // while N concurrent same-worker requests hold theirs → pool-vs-lock deadlock, same
    // discipline as the consent read). FAIL CLOSED on this write path: a payer with no
    // resolvable org collapses into the IDENTICAL neutral body (no distinguishable error →
    // no oracle). Resolved before any tx-external read so nothing leaks for a no-org caller.
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) return neutralUnavailable();

    // ---- [1] consent + render-source resolved BEFORE the lock (pool-vs-lock deadlock
    // fix; mirrors UnlockService). Both are tx-external reads on the global pool. ----
    const consented = await this.isConsentedForSharing(workerId);
    const workerPresent = consented || (await this.workerExists(workerId));
    // The name-free render source (latest snapshot). Reading it pre-lock is safe — it
    // is not contended and carries NO PII (the real name is NOT in the snapshot).
    const source = consented ? await this.repo.findResumeSource(workerId) : undefined;

    const plan = await this.repo.withTransaction<DisclosurePlan>(async (tx) => {
      // Serialize grants/reveals for this worker — SAME advisory key as unlock, so the
      // SHARED ceiling is atomic across both streams (B-B / F-2).
      await this.repo.lockWorker(tx, workerId);

      // ---- [1] employer_sharing consent gate (fail closed; no oracle) -------------
      if (!consented) {
        // Record a denied row ONLY when the worker exists (no_consent). For an unknown
        // worker, writing a row would violate the worker_id FK → a 500 oracle, so we
        // write NOTHING and return the IDENTICAL neutral body (no_consent ≡ unknown).
        if (workerPresent) {
          await this.recordDeny(tx, orgId, payerId, workerId, jobPostingId, "no_consent");
        }
        return { kind: "neutral" };
      }

      // ---- [2] SHARED worker-protection cap (atomic, under the lock) --------------
      if (await this.isOverSharedCap(tx, workerId)) {
        await this.recordDeny(tx, orgId, payerId, workerId, jobPostingId, "capped");
        return { kind: "neutral" };
      }

      // Nothing to disclose (no resume snapshot yet) → neutral, no row (no oracle: a
      // consented worker with no resume looks identical to capped/no-consent/unknown).
      if (!source) return { kind: "neutral" };

      // Idempotency: a LIVE disclosure for (org, worker, posting) → reuse it; re-mint its
      // link below WITHOUT a second grant or a second resume.disclosed event. ADR-0027
      // B5.x Inc 4: keyed on the OWNING org, so any member of the org converges on the same
      // disclosure row (a teammate re-requesting the same worker+posting draws no new grant).
      const existing = await this.repo.findByOrgWorkerPosting(tx, orgId, workerId, jobPostingId);
      if (
        existing &&
        existing.status === "disclosed" &&
        existing.expiresAt &&
        existing.expiresAt.getTime() > Date.now()
      ) {
        return {
          kind: "reuse",
          disclosureId: existing.id,
          objectKey: this.objectKey(workerId, existing.id),
          expiresAt: existing.expiresAt,
        };
      }

      // ---- [4] GRANT (status=granted; clears any prior deny). -----------------------
      // ADR-0027 B5.x Inc 4: a fresh insert stamps BOTH org_id (ownership) + payer_id (acting).
      const row = existing
        ? await this.repo.updateStatus(tx, existing.id, { status: "granted", denyReason: null })
        : await this.repo.insertRow(tx, { orgId, payerId, workerId, jobPostingId, status: "granted" });
      return { kind: "render", disclosureId: row.id };
    });

    // ---- post-commit (advisory lock released) -----------------------------------
    if (plan.kind === "neutral") return neutralUnavailable();

    if (plan.kind === "reuse") {
      // Re-mint a fresh short-TTL link for the already-disclosed masked artifact (no
      // re-render, no new event). On any failure → neutral (fail closed).
      try {
        const url = await this.storage.createSignedUrl(
          plan.objectKey,
          this.config.RESUME_SIGNED_URL_TTL_SECONDS,
        );
        return this.granted(plan.disclosureId, url, plan.expiresAt);
      } catch {
        this.logger.warn(`disclosure re-sign failed for disclosure=${plan.disclosureId}`);
        return neutralUnavailable();
      }
    }

    // plan.kind === "render": [5] CONTROLLED DISCLOSURE — render the MASKED resume.
    // `source` is non-undefined on this path (we returned neutral above when absent).
    return this.renderAndDisclose(plan.disclosureId, payerId, workerId, jobPostingId, source!, ctx);
  }

  /**
   * List the acting payer's ORG's disclosures (ADR-0027 B5.x Inc 4). Resolves the owning org
   * and lists ON `org_id`, so any member sees the whole org's disclosures. A payer with no
   * resolvable org gets an EMPTY list (fail-closed read — never a distinguishable error). Name
   * kept (`listByPayer`) so both controller call sites (ops + payer-portal) compile unchanged.
   */
  async listByPayer(
    payerId: string,
  ): Promise<{ disclosures: Awaited<ReturnType<ResumeDisclosureRepository["listByOrg"]>> }> {
    const orgId = await this.resolveOrgId(payerId);
    if (orgId === null) return { disclosures: [] };
    return { disclosures: await this.repo.listByOrg(orgId) };
  }

  // ---------------------------------------------------------------------------
  // [5] the controlled-disclosure step — the ONLY PII (real name) touch (F-5/B-G)
  // ---------------------------------------------------------------------------
  private async renderAndDisclose(
    disclosureId: string,
    payerId: string,
    workerId: string,
    jobPostingId: string | null,
    source: NonNullable<Awaited<ReturnType<ResumeDisclosureRepository["findResumeSource"]>>>,
    ctx: RequestContext,
  ): Promise<DisclosureOutcome> {
    // The real name is read ONCE here to derive the MASK, then discarded. It is NEVER
    // bound into the document, logged, evented, or persisted (F-5 / B-G). Decrypt
    // failure → render name-less (degrade), NOT a thrown error that could embed PII.
    let maskedName: string | null = null;
    const worker = await this.workers.findById(workerId);
    if (worker?.fullName) {
      try {
        maskedName = maskInitials(this.pii.decrypt(worker.fullName));
      } catch {
        this.logger.warn(`could not decrypt full_name for worker ${workerId}; masked-nameless render`);
      }
    }

    const renderInput = buildResumeRenderInput(source.sourceProfileSnapshot, maskedName, source.templateId);

    let pdf: Buffer | null;
    try {
      pdf = await this.renderer.renderPdf(renderInput);
    } catch {
      pdf = null; // never surface the error (could embed input); fail closed below
    }
    if (!pdf) {
      // Render disabled / WeasyPrint missing / failed → disclose nothing this run. The
      // granted row stays 'granted' for a retry; no event (nothing was disclosed).
      this.logger.warn(`masked resume not rendered for disclosure=${disclosureId}; returning neutral`);
      return neutralUnavailable();
    }

    // Employer artifact lives at a DISCLOSURE-scoped key — NEVER the worker's own PDF
    // key (which holds the real name). PRIVATE bucket + short-TTL signed URL only.
    const objectKey = this.objectKey(workerId, disclosureId);
    let url: string;
    try {
      await this.storage.uploadPdf(objectKey, pdf);
      url = await this.storage.createSignedUrl(objectKey, this.config.RESUME_SIGNED_URL_TTL_SECONDS);
    } catch {
      this.logger.warn(`upload/sign failed for disclosure=${disclosureId}; returning neutral`);
      return neutralUnavailable();
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.RESUME_SIGNED_URL_TTL_SECONDS * 1000);
    await this.repo.markDisclosed(disclosureId, { resumeRef: source.resumeId, disclosedAt: now, expiresAt });

    // emit resume.disclosed — the FACT only (B-E). NEVER the bytes/name/url.
    const payload: PayloadInputOf<"resume.disclosed"> = {
      disclosure_id: disclosureId,
      payer_id: payerId,
      worker_id: workerId,
      job_posting_id: jobPostingId,
      resume_ref: source.resumeId,
    };
    try {
      await this.events.emit({
        event_name: "resume.disclosed",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload,
        idempotencyKey: `resume.disclosed:${disclosureId}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      // The disclosure committed; an emit failure must not leak or roll it back. Log
      // class only (no PII — the payload is ids, but keep the discipline).
      this.logger.error(`resume.disclosed emit failed: ${err instanceof Error ? err.name : "unknown"}`);
    }

    return this.granted(disclosureId, url, expiresAt);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * SHARED per-worker ceiling: unlock reveals + resume disclosures, in one budget.
   * ADR-0027 B5.x Inc 4: the SHARED per-worker DAILY ceiling
   * (`countDisclosuresToPayersSince` — counts by worker across all payers) is UNCHANGED;
   * only the distinct-payers WEEKLY cap flips to distinct EMPLOYERS (orgs) via
   * `countDistinctOrgsSince`, so a whole recruiting team (many payers, one org) counts as
   * ONE org across the unlocks+disclosures union. BEHAVIOR-PRESERVING under solo orgs.
   */
  private async isOverSharedCap(tx: Tx, workerId: string): Promise<boolean> {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const daily = await this.repo.countDisclosuresToPayersSince(tx, workerId, dayAgo);
    if (daily >= this.config.UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY) return true;

    const orgs = await this.repo.countDistinctOrgsSince(tx, workerId, weekAgo);
    if (orgs >= this.config.UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK) return true;

    return false;
  }

  /**
   * Record a DENIED disclosure row for the audit spine — idempotent on (org, worker, posting)
   * (ADR-0027 B5.x Inc 4). Threads `orgId` so the lookup + INSERT are org-keyed and stamp
   * BOTH org_id (ownership) + payer_id (still NOT NULL — the acting payer).
   */
  private async recordDeny(
    tx: Tx,
    orgId: string,
    payerId: string,
    workerId: string,
    jobPostingId: string | null,
    reason: DisclosureDenyReason,
  ): Promise<void> {
    const existing = await this.repo.findByOrgWorkerPosting(tx, orgId, workerId, jobPostingId);
    if (existing) {
      await this.repo.updateStatus(tx, existing.id, { status: "denied", denyReason: reason });
    } else {
      await this.repo.insertRow(tx, { orgId, payerId, workerId, jobPostingId, status: "denied", denyReason: reason });
    }
  }

  /**
   * Disclosure-scoped object key — opaque ids only; NEVER the worker's own PDF key
   * (`resumes/...`, which holds the real name). Keyed by the STABLE disclosure id (not
   * the resume version) so a fresh render (after expiry, possibly a newer snapshot) and
   * an in-window re-sign always target the SAME object — no version drift (Low-1).
   */
  private objectKey(workerId: string, disclosureId: string): string {
    return `disclosures/${workerId}/${disclosureId}/resume.pdf`;
  }

  private granted(disclosureId: string, url: string, expiresAt: Date): DisclosureGrantedResponse {
    return {
      ok: true,
      disclosure_id: disclosureId,
      status: "disclosed",
      resume_url: url,
      expires_at: expiresAt.toISOString(),
    };
  }

  /** Fail-closed disclosure-consent read (B-A): latest unrevoked employer_sharing row. */
  private async isConsentedForSharing(workerId: string): Promise<boolean> {
    try {
      const latest = await this.consents.findLatestByWorker(workerId);
      if (!latest || latest.revokedAt !== null) return false;
      const purposes = (latest.purposes ?? []) as string[];
      return purposes.includes(EMPLOYER_SHARING);
    } catch {
      return false; // fail closed
    }
  }

  private async workerExists(workerId: string): Promise<boolean> {
    try {
      return (await this.workers.findById(workerId)) !== undefined;
    } catch {
      return false;
    }
  }
}
