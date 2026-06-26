import "server-only";
import { notFound } from "next/navigation";
// Frontend-SAFE subpath: `@badabhai/config/shared` carries only the env helpers (zod-only, no
// secrets) — NEVER the secret-bearing root (`@badabhai/config`), per the server/public split.
import { isDevEnv } from "@badabhai/config/shared";
import { requirePayer } from "./index";
import type { PayerSession } from "./types";

/**
 * ORG-MEMBER RBAC (Owner vs Recruiter) — a SECOND role dimension layered ON TOP OF the
 * account role (`employer | agent`), which is left UNCHANGED (roles.ts owns that one).
 *
 *  - ACCOUNT role ({@link PayerSession.role} / roles.ts): which PRODUCT surface — company vs
 *    agency. Decides which labeled DEMAND pages a session sees.
 *  - ORG role (here): what THIS member may do INSIDE their org —
 *      • Owner     → billing/wallet (credits) + user management (team) + everything a Recruiter sees;
 *      • Recruiter → post / search / unlock / contact only (LEAST PRIVILEGE).
 *
 * SECURITY (XB-A / XT3 — mirrors roles.ts): the org role is a SERVER-side decision input; the
 * gate ({@link requireOwner}) returns a NEUTRAL `notFound()` (404) on a mismatch — never a
 * "forbidden" oracle and never a client-side hide. A Recruiter cannot even learn an Owner-only
 * route exists. The session org role is for LABELS/affordances only (the nav); the GATE decides.
 *
 * FAIL-CLOSED (least privilege): the signed session carries NO org-role claim today, so
 * {@link getOrgRole} defaults to `recruiter`. A dev-only override (gated by {@link isDevEnv},
 * which reads RAW `NODE_ENV` and fails closed in staging/prod) lets us PREVIEW the Owner UI
 * locally — it can NEVER grant Owner in staging/production.
 */

export type OrgRole = "owner" | "recruiter";

/** Dev-only override env var to PREVIEW the Owner UI locally (ignored outside dev/test). */
const DEV_ORG_ROLE_ENV = "PAYER_DEV_ORG_ROLE";

/**
 * Resolve the member's ORG role for the current session.
 *
 * // STUB: org-role not yet in the signed session — wire to Divyanshu's org API + session
 * // claim when it lands (XB-A: the claim rides the signed session; a client never supplies it).
 *
 * Until then this FAILS CLOSED to `recruiter` (least privilege). The only non-default path is a
 * DEV-ONLY preview override (`PAYER_DEV_ORG_ROLE=owner|recruiter`), honored ONLY when
 * {@link isDevEnv} is true (raw `NODE_ENV` is "development"/"test"). In staging/production it is
 * ignored, so a stray env var can never unlock Owner.
 */
export function getOrgRole(_session: PayerSession): OrgRole {
  // Dev-only preview override. isDevEnv() reads the RAW NODE_ENV and fails closed, so this
  // branch is dead in staging/prod regardless of the env var's value.
  if (isDevEnv()) {
    const override = (process.env[DEV_ORG_ROLE_ENV] ?? "").trim().toLowerCase();
    if (override === "owner") return "owner";
    if (override === "recruiter") return "recruiter";
  }
  // No org-role claim on the signed session yet ⇒ least privilege.
  return "recruiter";
}

/**
 * Gate an OWNER-only section (billing/wallet = credits; user management = team). Resolve the
 * session and assert the OWNER org role, else 404 NEUTRALLY. Same no-oracle discipline as
 * {@link import("./roles").requireAgent} — a Recruiter gets a plain not-found, never a leak that
 * the Owner section exists.
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
