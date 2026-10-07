import "server-only";
import { notFound } from "next/navigation";
// Frontend-SAFE subpath: `@badabhai/config/shared` carries only the env helpers (zod-only, no
// secrets) — NEVER the secret-bearing root (`@badabhai/config`), per the server/public split.
import { isDevEnv } from "@badabhai/config/shared";
import { requirePayer } from "./index";
import type { OrgRole, PayerSession } from "./types";

/**
 * ORG-MEMBER RBAC (Owner vs Recruiter) — a SECOND role dimension layered ON TOP OF the
 * account role (`employer | agent`), which is left UNCHANGED (roles.ts owns that one).
 *
 *  - ACCOUNT role ({@link PayerSession.role} / roles.ts): which PRODUCT surface — company vs
 *    agency. Decides which labeled DEMAND pages a session sees.
 *  - ORG role (here): what THIS member may do INSIDE their org —
 *      • Owner     → user management (Team) + everything a Recruiter does;
 *      • Recruiter → post / search / unlock / contact / BUY CREDITS (LEAST PRIVILEGE).
 *    Billing is NOT an owner power: any member can view the wallet and buy credits (owner ruling
 *    2026-10-07), so /credits and its actions gate on `requirePayer()`, not on this module.
 *
 * SECURITY (XB-A / XT3 — mirrors roles.ts): the org role is a SERVER-side decision input; the
 * gate ({@link requireOwner}) returns a NEUTRAL `notFound()` (404) on a mismatch — never a
 * "forbidden" oracle and never a client-side hide. A Recruiter cannot even learn an Owner-only
 * route exists. The session org role is for LABELS/affordances only (the nav); the GATE decides.
 * And the gate here is a MIRROR: the API enforces Owner-only itself (`PayerOrgRoleGuard` answers
 * 403 on the member writes — invite / remove), so this gate shapes what a member is offered; it
 * is not the last line.
 *
 * SOURCE OF THE ROLE (#2079): `GET /payer/me` `orgRole`, which the backend reads from
 * `payer_members` on EVERY call. {@link requirePayer} already makes that read on every request
 * to resolve the session (`currentSession()`), so the role rides it at ZERO extra round trips and
 * is exactly as fresh as the request — a demoted owner is refused on their next request. The
 * payer JWT's `org_role` claim is deliberately NOT read: payer-web cannot verify the token's
 * signature, so a claim decoded from the cookie is client-controlled input (http-provider.ts).
 *
 * FAIL-CLOSED (least privilege): only an explicit `"owner"` grants Owner. `null` (no active
 * membership), an absent field (an API older than #2079) and a value outside the enum (degraded
 * to `null` by the wire schema) all read as `recruiter`; a failed /me read yields no session at
 * all (→ /login). A dev-only override (gated by {@link isDevEnv}, which reads RAW `NODE_ENV` and
 * fails closed in staging/prod) lets us PREVIEW either role locally — it can NEVER grant Owner in
 * staging/production.
 */

export type { OrgRole } from "./types";

/** Dev-only override env var to PREVIEW the Owner UI locally (ignored outside dev/test). */
const DEV_ORG_ROLE_ENV = "PAYER_DEV_ORG_ROLE";

/**
 * Resolve the member's ORG role for a session resolved by {@link requirePayer} (or a gate built
 * on it) — i.e. from `GET /payer/me` `orgRole` on this request (#2079). XB-A: the role is the
 * server's answer for the session's own identity; a client never supplies it.
 *
 * FAILS CLOSED to `recruiter` for anything but an explicit `"owner"`. The only other path is a
 * DEV-ONLY preview override (`PAYER_DEV_ORG_ROLE=owner|recruiter`), honored ONLY when
 * {@link isDevEnv} is true (raw `NODE_ENV` is "development"/"test"), where it wins over the real
 * role so either UI can be previewed. In staging/production it is ignored, so a stray env var can
 * never unlock Owner.
 */
export function getOrgRole(session: PayerSession): OrgRole {
  // Dev-only preview override. isDevEnv() reads the RAW NODE_ENV and fails closed, so this
  // branch is dead in staging/prod regardless of the env var's value.
  if (isDevEnv()) {
    const override = (process.env[DEV_ORG_ROLE_ENV] ?? "").trim().toLowerCase();
    if (override === "owner") return "owner";
    if (override === "recruiter") return "recruiter";
  }
  // The CURRENT membership role from this request's /payer/me. Strict equality, so null, an
  // absent field or anything unexpected is least privilege — never a truthiness check.
  return session.orgRole === "owner" ? "owner" : "recruiter";
}

/**
 * Gate an OWNER-only section (user management = Team). Resolve the session and assert the OWNER
 * org role, else 404 NEUTRALLY. Same no-oracle discipline as
 * {@link import("./roles").requireAgent} — a Recruiter gets a plain not-found, never a leak that
 * the Owner section exists.
 *
 * FRESH PER REQUEST: {@link requirePayer} reads `GET /payer/me` each time it runs (nothing is
 * cached across requests), so the role this gate checks is the backend's CURRENT membership —
 * never a token claim minted before a demotion.
 */
export async function requireOwner(): Promise<PayerSession> {
  const session = await requirePayer();
  if (getOrgRole(session) !== "owner") {
    notFound();
  }
  return session;
}

/**
 * Gate a MEMBER-area section. Owner ⊇ Recruiter, so BOTH org roles are admitted (an Owner sees
 * everything a Recruiter sees). The neutral-404 discipline still holds: any value OUTSIDE the
 * known set fails closed. There is no Recruiter-EXCLUSIVE surface — this exists for symmetry and
 * an explicit "must be a logged-in member" gate.
 */
export async function requireRecruiter(): Promise<PayerSession> {
  const session = await requirePayer();
  const role = getOrgRole(session);
  if (role !== "owner" && role !== "recruiter") {
    notFound();
  }
  return session;
}
