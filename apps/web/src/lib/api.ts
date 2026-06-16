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
  method: "POST" | "PATCH",
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
