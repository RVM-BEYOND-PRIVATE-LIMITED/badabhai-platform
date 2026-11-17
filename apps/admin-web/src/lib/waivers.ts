import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/** #2750 part C — RVM placement-team waivers of the contact cost. */
export const waiverSchema = z.object({
  waiver_id: z.string(),
  scope: z.enum(["company", "job"]),
  company_id: z.string(),
  posting_id: z.string().nullable(),
  active: z.boolean(),
  source: z.enum(["campus", "admin"]),
  set_by_ref: z.string().nullable(),
  set_by_label: z.string().nullable(),
  reason: z.string(),
  set_at: z.string(),
  cleared_at: z.string().nullable(),
  cleared_by_ref: z.string().nullable(),
  cleared_by_label: z.string().nullable(),
  clear_reason: z.string().nullable(),
  waived_opens: z.number().int().nonnegative(),
});
export type Waiver = z.infer<typeof waiverSchema>;

const listSchema = z.object({
  waivers: z.array(waiverSchema),
  next_cursor: z.string().nullable(),
});
export type WaiversPage = z.infer<typeof listSchema>;

const writeSchema = z.object({
  active: z.boolean(),
  changed: z.boolean(),
  waiver: waiverSchema.nullable(),
});
export type WaiverWrite = z.infer<typeof writeSchema>;

export async function getWaivers(input: {
  companyId?: string;
  includeCleared?: boolean;
  cursor?: string;
  limit?: number;
} = {}): Promise<WaiversPage> {
  const qs = new URLSearchParams();
  if (input.companyId) qs.set("company_id", input.companyId);
  if (input.includeCleared) qs.set("include_cleared", "true");
  if (input.cursor) qs.set("cursor", input.cursor);
  if (input.limit !== undefined) qs.set("limit", String(input.limit));
  const query = qs.toString();
  return adminFetch(`/admin/waivers${query ? `?${query}` : ""}`, { schema: listSchema });
}

export async function setWaiver(input: {
  scope: "company" | "job";
  companyId: string;
  postingId?: string;
  active: boolean;
  reasonText: string;
}): Promise<WaiverWrite> {
  return adminFetch("/admin/waivers", {
    method: "PUT",
    body: {
      scope: input.scope,
      company_id: input.companyId,
      ...(input.postingId ? { posting_id: input.postingId } : {}),
      active: input.active,
      reason_text: input.reasonText,
    },
    schema: writeSchema,
  });
}
