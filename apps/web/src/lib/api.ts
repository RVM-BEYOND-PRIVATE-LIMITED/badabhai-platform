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
// Job postings (ADR-0010 — ops-created, vacancy-banded, stored-only).
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
