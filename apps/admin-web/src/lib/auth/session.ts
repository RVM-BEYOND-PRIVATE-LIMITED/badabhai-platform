import "server-only";
import { redirect } from "next/navigation";
import { z } from "zod";
import { adminFetch, isAdminUnauthorized } from "../admin-http";
import {
  isAdminCapability,
  isAdminRole,
  type AdminCapability,
  type AdminRole,
} from "./capabilities";

/**
 * The authenticated admin, as the SERVER describes them (`GET /admin/me`).
 *
 * Deliberately PII-free — id, role, capabilities and nothing else. There is no admin name
 * or email here because the endpoint does not return one (invariant #2): admin email is
 * ADMIN-class PII, accepted at login and never echoed back.
 */
export interface AdminSession {
  adminId: string;
  role: AdminRole;
  capabilities: AdminCapability[];
}

const meSchema = z.object({
  admin_id: z.string().min(1),
  role: z.string().min(1),
  // Unknown capability strings are DROPPED rather than trusted: a future server may add
  // one this build has never heard of, and rendering a control for it would be guessing.
  capabilities: z.array(z.string()).default([]),
});

/**
 * Resolve the current session, or null when unauthenticated.
 *
 * Every render asks the SERVER who this is; the cookie is only a bearer token, never a
 * source of identity. That means a session revoked elsewhere (logout on another device,
 * an admin suspension, the MFA reset route) takes effect on the very next page load
 * instead of lingering until the JWT's own expiry.
 */
export async function currentSession(): Promise<AdminSession | null> {
  try {
    const me = await adminFetch("/admin/me", { schema: meSchema });
    if (!isAdminRole(me.role)) return null; // unknown role ⇒ trust nothing
    return {
      adminId: me.admin_id,
      role: me.role,
      // `?? []` as well as the schema default: the two together mean a response with a
      // missing, null, or wrongly-typed list yields NO capabilities rather than throwing
      // — fail closed, and the operator sees a portal with no privileged controls.
      capabilities: (me.capabilities ?? []).filter(isAdminCapability),
    };
  } catch (err) {
    if (isAdminUnauthorized(err)) {
      // Dead or absent token ⇒ simply "not signed in".
      //
      // NOTE: we deliberately do NOT clear the cookie here. Next.js forbids mutating
      // cookies during a render ("Cookies can only be modified in a Server Action or
      // Route Handler"), and doing so threw a 500 on every anonymous request — turning
      // "you are logged out" into "the portal is broken". Clearing is the job of
      // `logoutAction`. A stale cookie costs one rejected API call per navigation and
      // still lands the operator on /login, which is the correct outcome anyway.
      return null;
    }
    // A 5xx or an unreachable API is NOT "logged out" — surfacing it as such would boot a
    // valid operator to /login during an outage and hide the real problem. Let it throw
    // into the error boundary, which says what actually happened.
    throw err;
  }
}

/**
 * Require a session or redirect to /login. The gate for every page under `(portal)`.
 *
 * This is the SECOND line of defence, not the first: every admin route enforces its own
 * guard server-side. If this check were removed, the portal would render its chrome and
 * every API call inside it would 401 — annoying, but not a data leak.
 */
export async function requireSession(): Promise<AdminSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Require a specific capability, else send the operator somewhere they can actually be.
 *
 * Used to gate a whole PAGE. In-page controls should instead render conditionally on
 * `can(...)`, so an operator sees a coherent screen rather than a wall.
 */
export async function requireCapability(capability: AdminCapability): Promise<AdminSession> {
  const session = await requireSession();
  if (!session.capabilities.includes(capability)) redirect("/?denied=" + capability);
  return session;
}
