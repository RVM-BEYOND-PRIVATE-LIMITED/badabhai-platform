"use server";

import { redirect } from "next/navigation";
import { adminFetch } from "../../lib/admin-http";
import { clearAdminToken } from "../../lib/auth/session-cookie";

/**
 * Sign out.
 *
 * TWO things have to happen, and the ORDER matters: revoke server-side first, then drop
 * the cookie. If the cookie went first and the revoke then failed, the operator would see
 * a logged-out portal while a live session token existed on the server — the worst of
 * both, because nobody would know to revoke it.
 *
 * The local clear is unconditional even when the revoke throws: a token we cannot revoke
 * is still a token we should stop presenting. The revoke failure surfaces as an error the
 * operator can act on rather than a silent half-logout.
 */
export async function logoutAction(): Promise<void> {
  try {
    await adminFetch("/admin/logout", { method: "POST" });
  } finally {
    await clearAdminToken();
  }
  redirect("/login");
}
