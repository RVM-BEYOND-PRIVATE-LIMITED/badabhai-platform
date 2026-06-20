import "server-only";
import { randomUUID } from "node:crypto";
import {
  VACANCY_BANDS,
  type CreditBalance,
  type FacelessApplicant,
  type PostingSummary,
  type UnlockHistoryItem,
} from "./contracts";
import { applicantQuotaStep, baseApplicantQuotaForBand } from "./pricing-config";

/**
 * In-memory MOCK data store (ADR-0019 Phase 1 — mock + staging-only).
 *
 * WHY THIS EXISTS: the backend has NO payer-scoped route group bound to
 * `PayerAuthGuard` yet (the existing unlock/disclosure/posting-plan controllers
 * sit behind `InternalServiceGuard` and take `payer_id` from the body; the
 * `PayersModule` is not even imported into `AppModule`). So the demand-loop data
 * is served from THIS store until those endpoints land. The swap is `payer-api.ts`:
 * replace each store call with a payer-scoped fetch — the contracts already match.
 *
 * TENANCY (XB-A): every accessor REQUIRES the authenticated payerId and only ever
 * returns/mutates rows under THAT key. There is no cross-payer read path: the store
 * is a Map keyed by payerId, and a caller can only pass the id from the server-held
 * session. This mirrors `payer-scope.ts`'s app-layer chokepoint on the backend.
 *
 * PII (invariant #2 / B-R2): the store holds NO raw worker PII — applicants are
 * faceless (opaque worker_id + banded taxonomy signals). No payer email/phone is
 * stored here (that lives only in the backend `payers` table, ADR-0004-protected).
 */

interface PayerState {
  balance: number;
  postings: PostingSummary[];
  unlocks: UnlockHistoryItem[];
  /** Faceless applicants per posting id. */
  applicantsByPosting: Map<string, FacelessApplicant[]>;
}

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86400_000).toISOString();
}

/** Faceless seed applicants — banded, taxonomy-only, NO name/phone/employer. */
function seedApplicants(): FacelessApplicant[] {
  return [
    {
      workerId: "aaaa1111-0000-4000-8000-000000000001",
      rank: 1,
      score: 0.92,
      hot: true,
      signals: ["trade match", "city match", "recent activity"],
      experienceBand: "3-5 yrs",
      tradeLabel: "CNC Machinist",
      cityLabel: "Pune",
      skills: ["VMC operation", "GD&T", "Fanuc"],
    },
    {
      workerId: "aaaa1111-0000-4000-8000-000000000002",
      rank: 2,
      score: 0.81,
      hot: false,
      signals: ["trade match", "city match"],
      experienceBand: "6-10 yrs",
      tradeLabel: "VMC Operator",
      cityLabel: "Pune",
      skills: ["VMC setting", "programming", "inspection"],
    },
    {
      workerId: "aaaa1111-0000-4000-8000-000000000003",
      rank: 3,
      score: 0.64,
      hot: false,
      signals: ["adjacent trade"],
      experienceBand: "1-2 yrs",
      tradeLabel: "CNC Trainee",
      cityLabel: "Nashik",
      skills: ["loading", "deburring"],
    },
  ];
}

function freshState(seed: { withData: boolean }): PayerState {
  if (!seed.withData) {
    return { balance: 0, postings: [], unlocks: [], applicantsByPosting: new Map() };
  }
  const postingId = "bbbb2222-0000-4000-8000-000000000001";
  const applicants = seedApplicants();
  return {
    balance: 50,
    postings: [
      {
        id: postingId,
        roleTitle: "CNC Machinist",
        locationLabel: "Pune, MH",
        vacancyBand: "6-20",
        status: "open",
        applicantCount: applicants.length,
        // Config-derived base quota for the seed band (never a hardcoded literal).
        applicantQuota: baseApplicantQuotaForBand("6-20") ?? applicants.length,
        createdAt: iso(-3),
      },
    ],
    unlocks: [],
    applicantsByPosting: new Map([[postingId, applicants]]),
  };
}

/** Process-global store. Reset per cold start — acceptable for a mock staging surface. */
const store = new Map<string, PayerState>([
  [PAYER_A, freshState({ withData: true })],
  [PAYER_B, freshState({ withData: false })],
]);

function stateFor(payerId: string): PayerState {
  let s = store.get(payerId);
  if (!s) {
    // An authenticated-but-unseeded payer gets an empty, isolated tenant.
    s = freshState({ withData: false });
    store.set(payerId, s);
  }
  return s;
}

/* ── Reads (all payer-scoped) ───────────────────────────────────────────────── */

export function getBalance(payerId: string): CreditBalance {
  return { payerId, balance: stateFor(payerId).balance };
}

export function getPostings(payerId: string): PostingSummary[] {
  return stateFor(payerId).postings.map((p) => ({ ...p }));
}

export function getUnlockHistory(payerId: string): UnlockHistoryItem[] {
  return stateFor(payerId).unlocks.map((u) => ({ ...u }));
}

/** Faceless applicants for ONE of the payer's own postings, or null if not theirs. */
export function getApplicants(
  payerId: string,
  postingId: string,
): { posting: PostingSummary; applicants: FacelessApplicant[] } | null {
  const s = stateFor(payerId);
  const posting = s.postings.find((p) => p.id === postingId);
  if (!posting) return null; // Not this payer's posting ⇒ neutral not-found (XB-A).
  return {
    posting: { ...posting },
    applicants: (s.applicantsByPosting.get(postingId) ?? []).map((a) => ({ ...a })),
  };
}

/** Does this payer own this posting? (tenant chokepoint for the unlock/reveal path) */
export function ownsPosting(payerId: string, postingId: string): boolean {
  return stateFor(payerId).postings.some((p) => p.id === postingId);
}

/* ── Writes (all payer-scoped) ──────────────────────────────────────────────── */

export function createPosting(
  payerId: string,
  input: { roleTitle: string; locationLabel?: string; vacancyBand: string },
): PostingSummary {
  const s = stateFor(payerId);
  const posting: PostingSummary = {
    id: randomUUID(),
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel ?? null,
    vacancyBand: input.vacancyBand,
    status: "open",
    applicantCount: 0,
    // Base applicant quota from CONFIG for this band (never a hardcoded literal);
    // an unknown band fail-closes to undefined (the page renders it as "—").
    applicantQuota: quotaForBand(input.vacancyBand),
    createdAt: new Date().toISOString(),
  };
  s.postings = [posting, ...s.postings];
  s.applicantsByPosting.set(posting.id, []);
  return { ...posting };
}

/** Config-derived base quota for a band string (fail-closed to undefined). */
function quotaForBand(band: string): number | undefined {
  const known = VACANCY_BANDS.find((b) => b === band);
  if (!known) return undefined;
  return baseApplicantQuotaForBand(known) ?? undefined;
}

/** Add credits to the payer's mock ledger. Returns the new balance. */
export function addCredits(payerId: string, credits: number): number {
  const s = stateFor(payerId);
  s.balance += credits;
  return s.balance;
}

/**
 * Atomically attempt to spend ONE credit for an unlock against a worker the payer
 * may see. Returns a granted record, or null for EVERY deny cause (no balance,
 * already unlocked, unknown worker) — the caller maps that single null to the
 * neutral no-oracle response (XB-C). No cause is ever surfaced.
 */
export function trySpendUnlock(payerId: string, workerId: string): UnlockHistoryItem | null {
  const s = stateFor(payerId);
  if (s.balance < 1) return null; // no-credits → neutral
  const existing = s.unlocks.find((u) => u.workerId === workerId && u.status === "granted");
  if (existing) return { ...existing }; // idempotent re-grant, indistinguishable
  s.balance -= 1;
  const unlock: UnlockHistoryItem = {
    unlockId: randomUUID(),
    workerId,
    status: "granted",
    createdAt: new Date().toISOString(),
    expiresAt: iso(14),
  };
  s.unlocks = [unlock, ...s.unlocks];
  return { ...unlock };
}

/** A granted unlock owned by this payer, by unlock id, or null (neutral on miss). */
export function findOwnedUnlock(payerId: string, unlockId: string): UnlockHistoryItem | null {
  return stateFor(payerId).unlocks.find((u) => u.unlockId === unlockId) ?? null;
}

/**
 * PAUSE one of the payer's OWN postings (open → paused). Returns the updated row, or
 * null if the posting isn't this payer's (neutral not-found, XB-A). Idempotent.
 */
export function pausePosting(payerId: string, postingId: string): PostingSummary | null {
  const s = stateFor(payerId);
  const posting = s.postings.find((p) => p.id === postingId);
  if (!posting) return null; // Not this payer's posting ⇒ neutral not-found.
  if (posting.status === "open") posting.status = "paused";
  return { ...posting };
}

/**
 * RESUME one of the payer's OWN postings (paused → open). Returns the updated row, or
 * null if the posting isn't this payer's (neutral not-found, XB-A). Idempotent.
 */
export function resumePosting(payerId: string, postingId: string): PostingSummary | null {
  const s = stateFor(payerId);
  const posting = s.postings.find((p) => p.id === postingId);
  if (!posting) return null; // Not this payer's posting ⇒ neutral not-found.
  if (posting.status === "paused") posting.status = "open";
  return { ...posting };
}

/**
 * TOP-UP a posting's applicant quota by ONE config'd step. The step is read from the
 * catalog (`applicantQuotaStep`) — never a client-supplied or hardcoded amount.
 * Returns the updated row, or null if the posting isn't this payer's / no config step.
 */
export function topUpPostingQuota(payerId: string, postingId: string): PostingSummary | null {
  const s = stateFor(payerId);
  const posting = s.postings.find((p) => p.id === postingId);
  if (!posting) return null; // Not this payer's posting ⇒ neutral not-found.
  const step = applicantQuotaStep();
  if (step === null) return null; // No config'd quota step ⇒ nothing to grant.
  posting.applicantQuota = (posting.applicantQuota ?? 0) + step;
  return { ...posting };
}

/** TEST-ONLY: reset a payer's tenant to a known seed (no production caller). */
export function __resetForTest(payerId: string, withData: boolean): void {
  store.set(payerId, freshState({ withData }));
}
