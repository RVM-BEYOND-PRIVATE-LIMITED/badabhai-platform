import type {
  WorkerStatus,
  ProfileStatus,
  LanguageCode,
  AiJobType,
  AiJobStatus,
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

/** View A — GET /reach/jobs/:jobId/applicants. Throws ApiError(404) for an unknown job. */
export function getJobApplicants(jobId: string): Promise<ApplicantList> {
  return apiGet<ApplicantList>(`/reach/jobs/${encodeURIComponent(jobId)}/applicants`);
}

/** View B — GET /reach/workers/:workerId/feed. Throws ApiError(404) if no profile. */
export function getWorkerFeed(workerId: string): Promise<WorkerFeed> {
  return apiGet<WorkerFeed>(`/reach/workers/${encodeURIComponent(workerId)}/feed`);
}
