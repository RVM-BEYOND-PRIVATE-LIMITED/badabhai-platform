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

async function apiGet<T>(path: string): Promise<T> {
  // Ops data must always be fresh; never cache it at the framework level.
  const res = await fetch(`${publicConfig.NEXT_PUBLIC_API_URL}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`API GET ${path} failed: ${res.status} ${res.statusText}`);
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

/**
 * Applicants on a job — GET /jobs/:jobId/applicants (ops, InternalServiceGuard).
 * PII-FREE: returns opaque `worker_id`s only.
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
