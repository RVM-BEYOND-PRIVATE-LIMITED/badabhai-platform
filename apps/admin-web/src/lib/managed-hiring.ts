import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * #2751 — the Managed Hiring desk (`/admin/managed-hiring/*`), gated on `work_managed_hiring`.
 * A 404 while the switch is off everywhere. The service never promises a hire.
 */

export const ADMIN_ORDER_STATUSES = ["open", "ended", "all"] as const;
export type AdminOrderStatus = (typeof ADMIN_ORDER_STATUSES)[number];

export const adminManagedOrderSchema = z.object({
  order_id: z.string(),
  payer_id: z.string(),
  job_posting_id: z.string(),
  tier: z.enum(["standard", "large"]),
  status: z.enum(["active", "met", "extended", "closed_unmet", "cancelled"]),
  price_inr: z.number(),
  target_count: z.number(),
  confirmed_count: z.number(),
  started_at: z.string().nullable(),
  due_at: z.string().nullable(),
  extended_until: z.string().nullable(),
  ended_at: z.string().nullable(),
  is_test: z.boolean(),
  created_at: z.string(),
});
export type AdminManagedOrder = z.infer<typeof adminManagedOrderSchema>;

export const adminManagedOrderDetailSchema = adminManagedOrderSchema.extend({
  workers: z.array(
    z.object({
      worker_id: z.string(),
      confirmed_at: z.string(),
      confirmed_by: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
export type AdminManagedOrderDetail = z.infer<typeof adminManagedOrderDetailSchema>;

export const adminManagedOrdersPageSchema = z.object({
  orders: z.array(adminManagedOrderSchema),
  next_cursor: z.string().nullable(),
});
export type AdminManagedOrdersPage = z.infer<typeof adminManagedOrdersPageSchema>;

export const adminCallbackRequestsPageSchema = z.object({
  requests: z.array(
    z.object({
      request_id: z.string(),
      payer_id: z.string(),
      job_posting_id: z.string(),
      vacancy_band: z.string(),
      reason: z.string(),
      is_test: z.boolean(),
      created_at: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
});
export type AdminCallbackRequestsPage = z.infer<typeof adminCallbackRequestsPageSchema>;

export function listAdminManagedOrders(status: AdminOrderStatus, cursor?: string) {
  const q = new URLSearchParams({ status });
  if (cursor) q.set("cursor", cursor);
  return adminFetch(`/admin/managed-hiring/orders?${q.toString()}`, {
    schema: adminManagedOrdersPageSchema,
  });
}

export function getAdminManagedOrder(orderId: string) {
  return adminFetch(`/admin/managed-hiring/orders/${encodeURIComponent(orderId)}`, {
    schema: adminManagedOrderDetailSchema,
  });
}

export function addManagedInterest(orderId: string, workerId: string, note: string) {
  return adminFetch(`/admin/managed-hiring/orders/${encodeURIComponent(orderId)}/interest`, {
    method: "POST",
    body: { worker_id: workerId, note },
    schema: adminManagedOrderDetailSchema,
  });
}

export function removeManagedInterest(orderId: string, workerId: string, reasonText: string) {
  return adminFetch(`/admin/managed-hiring/orders/${encodeURIComponent(orderId)}/interest`, {
    method: "DELETE",
    body: { worker_id: workerId, reason_text: reasonText },
    schema: adminManagedOrderDetailSchema,
  });
}

export function listAdminCallbackRequests(cursor?: string) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return adminFetch(`/admin/managed-hiring/callback-requests${q}`, {
    schema: adminCallbackRequestsPageSchema,
  });
}

export function managedOrderStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "met":
      return "Met";
    case "extended":
      return "Extended";
    case "closed_unmet":
      return "Closed — not met";
    case "cancelled":
      return "Cancelled";
    default:
      return status.replace(/_/g, " ");
  }
}
