import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * #2887 — moved RVM students and their visibility switches (`/admin/students`).
 *
 * Gated on `manage_student_visibility` (super_admin, ops_admin). A 404 means
 * `STUDENT_MOVE_ENABLED` is off; a 503 means its table is missing. No name or phone is ever
 * returned — ids, a flag, reference labels and times only.
 */

export const movedStudentSchema = z.object({
  worker_id: z.string(),
  visible: z.boolean(),
  batch_id: z.string().nullable(),
  branch: z.string().nullable(),
  course: z.string().nullable(),
  changed_at: z.string(),
});
export type MovedStudent = z.infer<typeof movedStudentSchema>;

export const movedStudentsPageSchema = z.object({
  students: z.array(movedStudentSchema),
  next_cursor: z.string().nullable(),
});
export type MovedStudentsPage = z.infer<typeof movedStudentsPageSchema>;

export interface MovedStudentFilters {
  batchId?: string;
  visible?: boolean;
  branch?: string;
  course?: string;
  cursor?: string;
  limit?: number;
}

export function listMovedStudents(filters: MovedStudentFilters = {}) {
  const q = new URLSearchParams();
  if (filters.batchId) q.set("batch_id", filters.batchId);
  if (filters.visible !== undefined) q.set("visible", String(filters.visible));
  if (filters.branch) q.set("branch", filters.branch);
  if (filters.course) q.set("course", filters.course);
  if (filters.cursor) q.set("cursor", filters.cursor);
  if (filters.limit !== undefined) q.set("limit", String(filters.limit));
  const qs = q.toString();
  return adminFetch(`/admin/students${qs ? `?${qs}` : ""}`, {
    schema: movedStudentsPageSchema,
  });
}

export function setStudentVisibility(workerId: string, visible: boolean, reasonText: string) {
  return adminFetch(`/admin/students/${encodeURIComponent(workerId)}/visibility`, {
    method: "PUT",
    body: { visible, reason_text: reasonText },
    schema: z.object({ student: movedStudentSchema, changed: z.boolean() }),
  });
}

export type BulkSelector =
  | { kind: "batch_id"; value: string }
  | { kind: "branch"; value: string }
  | { kind: "course"; value: string };

export function setBulkStudentVisibility(
  selector: BulkSelector,
  visible: boolean,
  reasonText: string,
) {
  return adminFetch("/admin/students/visibility", {
    method: "POST",
    body: {
      visible,
      reason_text: reasonText,
      [selector.kind]: selector.value,
    },
    schema: z.object({ changed: z.number() }),
  });
}
