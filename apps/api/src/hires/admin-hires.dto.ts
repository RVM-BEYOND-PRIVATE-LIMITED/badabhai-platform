import { z } from "zod";
import { HIRE_STATUSES, type ApplicantPostingKind, type HireStatus } from "@badabhai/types";
import {
  ADMIN_ENTITIES_PAGE_DEFAULT,
  ADMIN_ENTITIES_PAGE_MAX,
  type AdminPage,
} from "../admin/admin-entities.dto";

/**
 * `GET /admin/hires` (#2753 item 9) — the admin entity lists' page controls (an opaque keyset
 * `cursor`, `limit` 1–100, default 50) and one filter, `status`. Strict: an unknown key is a 400.
 */
export const AdminHiresQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_ENTITIES_PAGE_MAX)
      .optional()
      .default(ADMIN_ENTITIES_PAGE_DEFAULT),
    status: z.enum(HIRE_STATUSES).optional(),
  })
  .strict();
export type AdminHiresQueryDto = z.infer<typeof AdminHiresQuerySchema>;

/**
 * One hire record, FACELESS: ids, the status, one timestamp per source (null until that source
 * said "hired"; never cleared) and `hired_on` (the India day of the first confirming source).
 * `tenant_payer_id` is the company's tenant key — the root payer id the Companies screens are
 * keyed by when org tenancy is on. No name, phone, title or note: like the admin applications
 * list, a row that joins a worker to a posting carries ids, and the worker's and the company's
 * own screens show who they are.
 */
export interface AdminHireListItem {
  id: string;
  tenant_payer_id: string;
  worker_id: string;
  posting_kind: ApplicantPostingKind;
  posting_id: string;
  status: HireStatus;
  company_marked_at: Date | null;
  company_answered_at: Date | null;
  worker_answered_at: Date | null;
  desk_confirmed_at: Date | null;
  hired_on: string | null;
  created_at: Date;
  updated_at: Date;
}

export type AdminHiresPage = AdminPage<AdminHireListItem>;
