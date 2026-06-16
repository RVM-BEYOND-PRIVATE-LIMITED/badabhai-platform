import type {
  WorkerStatus,
  ProfileStatus,
  LanguageCode,
  AiJobType,
  AiJobStatus,
  VacancyBand,
  JobPostingStatus,
} from "@badabhai/types";
import { publicConfig } from "./config";

/**
 * Typed client for the read-only ops endpoints on the NestJS API.
 *
 * Models reuse the shared @badabhai/types enums so the console and the backend
 * agree on status/role vocabularies. These endpoints never expose PII
 * (phone/full name) — see the API controllers.
 */

export interface WorkerListItem {
  id: string;
  status: WorkerStatus;
  preferred_language: LanguageCode | null;
  created_at: string;
  profile_status: ProfileStatus | null;
  canonical_role_id: string | null;
  canonical_trade_id: string | null;
}

export interface EventListItem {
  id: string;
  event_name: string;
  event_version: number;
  actor_type: string;
  subject_type: string;
  subject_id: string | null;
  occurred_at: string;
  correlation_id: string;
}

export interface AiJobListItem {
  id: string;
  job_type: AiJobType;
  status: AiJobStatus;
  created_at: string;
  updated_at: string;
}

/** Apply/skip decision recorded by a worker (ADR-0009 alpha swipe-to-apply). */
export type ApplicationAction = "applied" | "skipped";

/**
 * One applicant on a job — the PII-FREE ops projection of GET /jobs/:jobId/applicants.
 * `worker_id` is an opaque UUID; the API never returns a name/phone for it.
 */
export interface JobApplicant {
  worker_id: string;
  action: ApplicationAction;
  reason: string | null;
  source_surface: string;
  rank: number | null;
  created_at: string;
  updated_at: string;
}

export interface JobApplicants {
  job_id: string;
  applicants: JobApplicant[];
}

/**
 * One application by a worker — the ops projection of GET
 * /workers/:workerId/applications. Carries only COARSE job fields (no employer,
 * no pay) plus the worker's decision.
 */
export interface WorkerApplication {
  job_id: string;
  trade_key: string;
  title: string;
  city: string;
  area: string | null;
  action: ApplicationAction;
  reason: string | null;
  source_surface: string;
  rank: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerApplications {
  worker_id: string;
  applications: WorkerApplication[];
}

export interface WorkerProfileRow {
  id: string;
  profileStatus: ProfileStatus;
  canonicalRoleId: string | null;
  canonicalTradeId: string | null;
  skills: string[];
  machines: string[];
  experience: Record<string, unknown>;
  confirmedAt: string | null;
  createdAt: string;
}

export interface GeneratedResumeRow {
  id: string;
  resumeText: string;
  version: number;
  generatedAt: string;
}

export interface WorkerProfileDetail {
  worker: {
    id: string;
    status: WorkerStatus;
    preferred_language: LanguageCode | null;
    created_at: string;
  };
  profile: WorkerProfileRow | null;
  resume: GeneratedResumeRow | null;
}

/**
 * Error thrown by `apiGet` when the API responds with a non-2xx status. Carries the
 * HTTP `status` so pages can distinguish an expected 404 (unknown job / no profile)
 * from a genuine backend outage.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function apiGet<T>(path: string): Promise<T> {
  // Ops data must always be fresh; never cache it at the framework level.
  const res = await fetch(`${publicConfig.NEXT_PUBLIC_API_URL}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `API GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Header carrying the shared internal-service secret (mirrors the API guard). */
const INTERNAL_SERVICE_TOKEN_HEADER = "x-internal-service-token";

/**
 * Server-only GET for ops endpoints behind the API's `InternalServiceGuard`
 * (e.g. the swipe-to-apply applicants reads). Identical to {@link apiGet} but
 * also attaches the `INTERNAL_SERVICE_TOKEN` shared secret.
 *
 * SECURITY: `INTERNAL_SERVICE_TOKEN` is a SERVER secret — it is read from
 * `process.env` (NOT `publicConfig`, which only whitelists `NEXT_PUBLIC_*`) and
 * is therefore never inlined into the client bundle. This module is imported only
 * by Server Components, so the token never crosses to the browser. If the token
 * is unset the guard fails closed (401) and the page renders its error state —
 * the secret is never surfaced.
 */
async function apiGetInternal<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (token) {
    headers[INTERNAL_SERVICE_TOKEN_HEADER] = token;
  }
  // Ops data must always be fresh; never cache it at the framework level.
  const res = await fetch(`${publicConfig.NEXT_PUBLIC_API_URL}${path}`, {
    cache: "no-store",
    headers,
  });
  if (!res.ok) {
    throw new Error(`API GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Server-only POST for ops endpoints behind the API's `InternalServiceGuard`
 * (the contact unlock + reveal writes — ADR-0010). Mirrors {@link apiGetInternal}:
 * attaches the `INTERNAL_SERVICE_TOKEN` shared secret read from `process.env`.
 *
 * SECURITY: `INTERNAL_SERVICE_TOKEN` is a SERVER secret. It is read from
 * `process.env` (NEVER `publicConfig` / `NEXT_PUBLIC_*`) so it is never inlined
 * into the client bundle. This function MUST only ever be invoked from a Server
 * Action / Server Component — never from client code. If the token is unset the
 * guard fails closed (401) and the caller renders its honest error state; the
 * secret is never surfaced.
 */
async function apiPostInternal<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (token) {
    headers[INTERNAL_SERVICE_TOKEN_HEADER] = token;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${publicConfig.NEXT_PUBLIC_API_URL}${path}`, {
    method: "POST",
    cache: "no-store",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `API POST ${path} failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

export async function listWorkers(): Promise<WorkerListItem[]> {
  const { workers } = await apiGet<{ workers: WorkerListItem[] }>("/workers");
  return workers;
}

export function getWorkerProfile(id: string): Promise<WorkerProfileDetail> {
  return apiGet<WorkerProfileDetail>(`/workers/${id}/profile`);
}

export async function listEvents(): Promise<EventListItem[]> {
  const { events } = await apiGet<{ events: EventListItem[] }>("/events");
  return events;
}

export async function listAiJobs(): Promise<AiJobListItem[]> {
  const { ai_jobs } = await apiGet<{ ai_jobs: AiJobListItem[] }>("/ai-jobs");
  return ai_jobs;
}

// ---------------------------------------------------------------------------
// Job postings (ADR-0012 — ops-created, vacancy-banded, stored-only).
//
// IMPORTANT: this endpoint returns the raw Drizzle row, so the wire shape is
// camelCase (orgLabel, vacancyBand, createdAt, …) — NOT snake_case like the
// /workers endpoint, which maps its fields by hand. Do not "fix" these to
// snake_case; they mirror packages/db JobPosting exactly.
//
// Unlike the read-only workers/events/ai-jobs views, these postings carry
// org/role/location text an OPS ACTOR typed and must see here. The FACELESS rule
// (Reach feed) and the PII rule (events/ai_jobs/logs) do not restrict this
// internal register view — the free text lives only on the row.
// ---------------------------------------------------------------------------

export interface JobPostingRow {
  id: string;
  createdBy: string;
  orgLabel: string;
  roleTitle: string;
  locationLabel: string | null;
  description: string | null;
  vacancyBand: VacancyBand;
  status: JobPostingStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** Body accepted by POST /job-postings. `created_by` is the stub ops-actor id. */
export interface CreateJobPostingBody {
  created_by: string;
  org_label: string;
  role_title: string;
  location_label?: string;
  description?: string;
  vacancy_band: VacancyBand;
}

/**
 * Body accepted by PATCH /job-postings/:id. Any subset of the free-text fields
 * and the band; `status` may ONLY be "open" (publish a draft) — closing uses the
 * dedicated close endpoint.
 */
export interface UpdateJobPostingBody {
  org_label?: string;
  role_title?: string;
  location_label?: string;
  description?: string;
  vacancy_band?: VacancyBand;
  status?: "open";
}

export async function listJobPostings(
  status?: JobPostingStatus,
): Promise<JobPostingRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiGet<JobPostingRow[]>(`/job-postings${qs}`);
}

export function getJobPosting(id: string): Promise<JobPostingRow> {
  return apiGet<JobPostingRow>(`/job-postings/${id}`);
}

/**
 * Surfaces the server's own error message (e.g. the 422 description PII reject,
 * or a 409 lifecycle conflict) so mutation UIs can show it verbatim instead of a
 * generic status line. Falls back to a status-text message when there is no body.
 */
async function apiWrite<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${publicConfig.NEXT_PUBLIC_API_URL}${path}`, {
    method,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(await extractApiError(res, `${method} ${path}`));
  }
  return (await res.json()) as T;
}

/** Pull a human-readable message out of a NestJS/Zod error body, if present. */
async function extractApiError(res: Response, label: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: unknown };
    const { message } = data;
    if (Array.isArray(message)) return message.join("; ");
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // No/!JSON body — fall through to the status-text message.
  }
  return `${label} failed: ${res.status} ${res.statusText}`;
}

export function createJobPosting(body: CreateJobPostingBody): Promise<JobPostingRow> {
  return apiWrite<JobPostingRow>("/job-postings", "POST", body);
}

export function updateJobPosting(
  id: string,
  body: UpdateJobPostingBody,
): Promise<JobPostingRow> {
  return apiWrite<JobPostingRow>(`/job-postings/${id}`, "PATCH", body);
}

export function closeJobPosting(id: string): Promise<JobPostingRow> {
  return apiWrite<JobPostingRow>(`/job-postings/${id}/close`, "POST");
}

/* ── Reach feed serving (ADR-0011) ─────────────────────────────────────────────
 * Read-only views over the deterministic RANK core. Every shape here is FACELESS:
 * opaque `workerId`/`jobId`, numeric `score`, booleans, and the engine's explainable
 * `components[]` — and nothing else. The API returns no contact/name/employer data on
 * this path, and the console never fetches or joins any. Responses are camelCase.
 */

/** One explainable signal contribution — the "why" behind a row's score. */
export interface ScoreComponent {
  signal: string;
  raw: number;
  weight: number;
  reason: string;
}

/** View A row — one ranked applicant for a job (keeps the core's hot / pushEligible). */
export interface ApplicantRow {
  workerId: string;
  rank: number;
  score: number;
  hot: boolean;
  pushEligible: boolean;
  components: ScoreComponent[];
}

export interface ApplicantList {
  jobId: string;
  applicants: ApplicantRow[];
}

/** View B row — one ranked job in a worker's feed (NO hot / pushEligible, per ADR D4). */
export interface FeedJobRow {
  jobId: string;
  rank: number;
  score: number;
  components: ScoreComponent[];
}

export interface WorkerFeed {
  workerId: string;
  feed: FeedJobRow[];
}

/**
 * Reach View A — GET /reach/jobs/:jobId/applicants (ranked, faceless). Throws
 * ApiError(404) for an unknown job. Named `getReachJobApplicants` to stay distinct from
 * the ADR-0009 swipe-to-apply ops read `getJobApplicants` (`/jobs/:id/applicants`) below.
 */
export function getReachJobApplicants(jobId: string): Promise<ApplicantList> {
  return apiGet<ApplicantList>(`/reach/jobs/${encodeURIComponent(jobId)}/applicants`);
}

/** Reach View B — GET /reach/workers/:workerId/feed. Throws ApiError(404) if no profile. */
export function getWorkerFeed(workerId: string): Promise<WorkerFeed> {
  return apiGet<WorkerFeed>(`/reach/workers/${encodeURIComponent(workerId)}/feed`);
}

/**
 * Applicants on a job — GET /jobs/:jobId/applicants (ops, InternalServiceGuard).
 * PII-FREE: returns opaque `worker_id`s only. (ADR-0009 swipe-to-apply ops read.)
 */
export function getJobApplicants(jobId: string): Promise<JobApplicants> {
  return apiGetInternal<JobApplicants>(`/jobs/${jobId}/applicants`);
}

/**
 * A worker's applications — GET /workers/:workerId/applications (ops,
 * InternalServiceGuard). Coarse job fields only (no employer, no pay).
 */
export function getWorkerApplications(workerId: string): Promise<WorkerApplications> {
  return apiGetInternal<WorkerApplications>(`/workers/${workerId}/applications`);
}

/* ── Contact unlock + reveal (ADR-0010, Stream A) ───────────────────────────────
 * THE MOST SECURITY-SENSITIVE SURFACE. All three endpoints are behind the API's
 * `InternalServiceGuard` and MUST be called server-side only (the shared secret
 * never reaches the browser) — they go through `apiPostInternal` / `apiGetInternal`.
 *
 * NO-ORACLE (F-1/F-3): `POST /unlocks` collapses no-consent / capped /
 * unknown-worker / already-unlocked-by-another / insufficient-credits into ONE
 * byte-identical `{ status: "unavailable" }`, HTTP 200. The console MUST treat the
 * neutral branch as a single opaque state and NEVER infer the cause. The only
 * legitimately-knowable signal is the payer's OWN credit balance (GET .../credits).
 */

/** Granted unlock — `POST /unlocks` success branch. PII-free routing record. */
export interface UnlockGranted {
  ok: true;
  unlock_id: string;
  status: "granted";
  expires_at: string;
}

/**
 * The neutral, no-oracle response shared by `POST /unlocks` and
 * `POST /unlocks/:id/reveal`. Carries NOTHING beyond the status — by design it is
 * indistinguishable across every failure cause. Do not add fields here.
 */
export interface UnlockUnavailable {
  status: "unavailable";
}

export type UnlockResult = UnlockGranted | UnlockUnavailable;

/**
 * Reveal success — the ROUTED RELAY HANDLE only. `relay_handle` is an opaque
 * routing token, NOT a phone number; there is no phone anywhere in this response.
 */
export interface RevealHandle {
  relay_handle: string;
  channel: "in_app_relay" | "proxy_number";
  expires_at: string;
}

export type RevealResult = RevealHandle | UnlockUnavailable;

/** A payer's own credit balance — the one legitimately-knowable signal. */
export interface PayerCredits {
  payer_id: string;
  balance: number;
}

export interface CreateUnlockBody {
  payer_id: string;
  worker_id: string;
  job_id?: string | null;
}

/** Type guard: did `POST /unlocks` grant the unlock? */
export function isUnlockGranted(r: UnlockResult): r is UnlockGranted {
  return "ok" in r && r.ok === true;
}

/** Type guard: did `POST /unlocks/:id/reveal` return a routed handle? */
export function isRevealHandle(r: RevealResult): r is RevealHandle {
  return "relay_handle" in r;
}

/**
 * `POST /unlocks` (InternalServiceGuard). Returns the granted record OR the
 * neutral `{ status: "unavailable" }`. Server-side only.
 */
export function createUnlock(body: CreateUnlockBody): Promise<UnlockResult> {
  return apiPostInternal<UnlockResult>("/unlocks", body);
}

/**
 * `POST /unlocks/:unlockId/reveal` (InternalServiceGuard). Returns the routed
 * relay handle OR the neutral `{ status: "unavailable" }`. Server-side only.
 */
export function revealUnlock(unlockId: string): Promise<RevealResult> {
  return apiPostInternal<RevealResult>(
    `/unlocks/${encodeURIComponent(unlockId)}/reveal`,
  );
}

/**
 * `GET /payers/:payerId/credits` (InternalServiceGuard). The payer's own balance
 * — the only legitimately-knowable signal on this surface. Server-side only.
 */
export function getPayerCredits(payerId: string): Promise<PayerCredits> {
  return apiGetInternal<PayerCredits>(
    `/payers/${encodeURIComponent(payerId)}/credits`,
  );
}

/**
 * MOCK credit-pack top-up — `POST /payers/:payerId/credits` (InternalServiceGuard).
 * ALPHA, NO REAL MONEY: grants the pack's credits and returns the new balance.
 * Server-side only (the shared secret never reaches the browser). 404 on an
 * unknown pack_code — surfaced as an honest error by the caller's server action.
 */
export interface MockTopUpResult {
  payer_id: string;
  balance: number;
  credits: number;
  pack_code: string;
}

export function purchaseCredits(
  payerId: string,
  packCode: string,
): Promise<MockTopUpResult> {
  return apiPostInternal<MockTopUpResult>(
    `/payers/${encodeURIComponent(payerId)}/credits`,
    { pack_code: packCode },
  );
}

/* ── Pricing catalog (ADR-0013, config-driven Pricing Engine) ──────────────────
 * PUBLIC endpoints — `/pricing` has NO guard, so these use the plain (no-secret)
 * `apiGet` / `apiPut`. The catalog is PII-free by construction (codes + integer ₹
 * only — never a payer name or worker identity).
 *
 * We deliberately keep the raw `catalog` as an OPAQUE, validated passthrough for
 * the PUT (the server's `@badabhai/pricing` `catalogSchema` is the source of truth
 * and rejects an invalid catalog with a verbatim 400). The console only needs a
 * MINIMAL STRUCTURAL view of the fields it RENDERS — defined below — so the web
 * app does not pull the pricing package's `zod` graph into the browser bundle.
 */

/** A posting plan tier (rendered fields only). */
export interface PostingTierView {
  code: string;
  priceInr: number;
  validityDays: number;
  applicantVisibilityQuota: number;
}

/** A boost tier (rendered fields only). */
export interface BoostTierView {
  code: string;
  priceInr: number;
  boostDays: number;
}

/** A credit-pack tier (rendered fields only) — the unlock flow's credit packs. */
export interface CreditPackTierView {
  code: string;
  priceInr: number;
  credits: number;
  windowDays: number;
}

/** A product = a code + a kind + its tiers (discriminated on `kind`). */
export type ProductView =
  | { kind: "posting"; code: string; tiers: PostingTierView[] }
  | { kind: "boost"; code: string; tiers: BoostTierView[] }
  | { kind: "credit_pack"; code: string; tiers: CreditPackTierView[] };

/** An automatic, time-boxed offer (rendered fields only). */
export interface OfferView {
  code: string;
  scope: { productCode: string; tierCode?: string };
  kind: "percent" | "flat";
  value: number;
  from: string;
  until: string;
}

/** A code-redeemed coupon (rendered fields only). */
export interface CouponView {
  code: string;
  scope: { productCode: string; tierCode?: string };
  kind: "percent" | "flat";
  value: number;
  from: string;
  until: string;
  totalUsageCap: number;
  perPayerLimit: number;
}

/**
 * The minimal structural catalog the console RENDERS. The full server catalog is
 * a superset (it also carries `version` / `floorPriceInr`); we keep the raw value
 * intact in {@link ActiveCatalog.catalog} for the PUT passthrough.
 */
export interface CatalogView {
  floorPriceInr?: number;
  products: ProductView[];
  offers: OfferView[];
  coupons: CouponView[];
}

/**
 * `GET /pricing/catalog` — the active, validated catalog + provenance.
 * `source: "default"` means a stored row was rejected (fail-closed) OR none
 * exists — the console surfaces it as a warning so ops know the DEFAULT is served.
 * `catalog` is typed against the rendered view but carries the full server object.
 */
export interface ActiveCatalog {
  catalog: CatalogView;
  revision: number;
  source: "db" | "default";
}

export function getPricingCatalog(): Promise<ActiveCatalog> {
  return apiGet<ActiveCatalog>("/pricing/catalog");
}

/** Audit descriptor required by the catalog PUT (field KEYS only — never values). */
export interface PricingChange {
  change_type: "plan" | "discount" | "coupon";
  entity_code: string;
  changed_fields: string[];
}

/** Body accepted by `PUT /pricing/catalog`. `catalog` is the FULL catalog object. */
export interface UpdatePricingCatalogBody {
  updated_by: string;
  catalog: unknown;
  change: PricingChange;
}

/**
 * `PUT /pricing/catalog` — publish a new revision. PUBLIC (no guard, no secret).
 * On an invalid catalog the server returns a 400 whose message is surfaced
 * VERBATIM via {@link extractApiError}; the invalid catalog is never stored.
 */
export function updatePricingCatalog(
  body: UpdatePricingCatalogBody,
): Promise<ActiveCatalog> {
  return apiWrite<ActiveCatalog>("/pricing/catalog", "PUT", body);
}
