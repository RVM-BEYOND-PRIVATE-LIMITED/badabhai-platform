import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { HIRE_STATUSES, type HireStatus } from "./hires-vocabulary";

/**
 * Hire records — `GET /admin/hires` (#2753 item 9; see docs/api/admin-hires-api-reference.md).
 *
 * The response is FACELESS: ids, the status and one timestamp per source. No name, phone or
 * note. The list is keyset-paged newest first; `nextCursor` is null on the last page.
 */
const hireRecordSchema = z.object({
  id: z.string(),
  tenant_payer_id: z.string(),
  worker_id: z.string(),
  posting_kind: z.enum(["company_posting", "agency_job"]),
  posting_id: z.string(),
  status: z.enum(HIRE_STATUSES),
  company_marked_at: z.string().nullable(),
  company_answered_at: z.string().nullable(),
  worker_answered_at: z.string().nullable(),
  desk_confirmed_at: z.string().nullable(),
  hired_on: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type HireRecord = z.infer<typeof hireRecordSchema>;

export const hiresPageSchema = z.object({
  items: z.array(hireRecordSchema),
  nextCursor: z.string().nullable(),
});
export type HiresPage = z.infer<typeof hiresPageSchema>;

export interface HireFilters {
  status?: HireStatus;
  cursor?: string;
  limit?: number;
}

/** The query string the API's strict DTO accepts: set values only, no `?status=`. */
export function hiresQuery(filters: HireFilters): string {
  const q = new URLSearchParams();
  if (filters.status) q.set("status", filters.status);
  if (filters.cursor) q.set("cursor", filters.cursor);
  if (filters.limit !== undefined) q.set("limit", String(filters.limit));
  const query = q.toString();
  return query ? `?${query}` : "";
}

export async function listHires(filters: HireFilters = {}): Promise<HiresPage> {
  return adminFetch(`/admin/hires${hiresQuery(filters)}`, { schema: hiresPageSchema });
}
