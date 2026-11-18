import { z } from "zod";
import { AdminPayerReasonTextSchema } from "../admin-payer-logins.dto";

/**
 * #2887 — the admin contract for the moved RVM students' visibility switch.
 *
 * The admin is the session's (`@CurrentAdmin().id`); no body field names one. `reason_text`
 * (15–500 characters, no hard identifiers) is stored on the visibility row and on the
 * `audit_logs` row of the same transaction.
 */

/** A branch or course as #2752 stores it: a short reference label. */
const ReferenceLabel = z.string().trim().min(1).max(150);

/** `GET /admin/students`: moved students, newest first. */
export const AdminListStudentsQuerySchema = z
  .object({
    batch_id: z.string().uuid().optional(),
    visible: z.enum(["true", "false"]).optional(),
    branch: ReferenceLabel.optional(),
    course: ReferenceLabel.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AdminListStudentsQuery = z.infer<typeof AdminListStudentsQuerySchema>;

/** `PUT /admin/students/:workerId/visibility`. */
export const AdminSetStudentVisibilitySchema = z
  .object({
    visible: z.boolean(),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type AdminSetStudentVisibilityDto = z.infer<typeof AdminSetStudentVisibilitySchema>;

/** `POST /admin/students/visibility`: exactly one selector. */
export const AdminBulkStudentVisibilitySchema = z
  .object({
    visible: z.boolean(),
    reason_text: AdminPayerReasonTextSchema,
    batch_id: z.string().uuid().optional(),
    branch: ReferenceLabel.optional(),
    course: ReferenceLabel.optional(),
  })
  .strict()
  .refine(
    (b) =>
      [b.batch_id, b.branch, b.course].filter((v) => v !== undefined).length === 1,
    { message: "name exactly one of batch_id, branch or course", path: ["batch_id"] },
  );
export type AdminBulkStudentVisibilityDto = z.infer<typeof AdminBulkStudentVisibilitySchema>;

/** One moved student. Ids, a flag, reference labels and times; no name or phone. */
export interface AdminStudentResponse {
  readonly worker_id: string;
  readonly visible: boolean;
  readonly batch_id: string | null;
  readonly branch: string | null;
  readonly course: string | null;
  readonly changed_at: string;
}

export interface AdminStudentPageResponse {
  readonly students: readonly AdminStudentResponse[];
  readonly next_cursor: string | null;
}

export interface AdminSetStudentVisibilityResponse {
  readonly student: AdminStudentResponse;
  /** False when he was already in that state: nothing was written. */
  readonly changed: boolean;
}

export interface AdminBulkStudentVisibilityResponse {
  /** How many students changed state (a repeat changes none). */
  readonly changed: number;
}
