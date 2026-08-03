/**
 * ADR-0038 — BREAK-GLASS: clear an admin's second factor so they can re-enrol.
 *
 * THE CASE THIS EXISTS FOR. A TOTP seed is displayed once at enrolment and stored encrypted;
 * it is recoverable from nowhere. `POST /admin/admins/:id/mfa/reset` handles the ordinary
 * lost-phone case — but it requires ANOTHER super_admin to call it, and it refuses a
 * self-reset (a route an admin could call for themselves would let anyone holding a stolen
 * session strip the second factor off the account they stole).
 *
 * So if the LAST super_admin loses their device, nothing inside the application can help:
 *   * `manage_admins` is super_admin-only, so no other admin can promote a replacement;
 *   * `db:bootstrap:admin` deliberately REFUSES once any super_admin exists.
 * The platform would be permanently locked out of its own admin surface. This is the exit.
 *
 * SAME TRUST BAR AS THE BOOTSTRAP CLI: shell access to the deployment plus database
 * credentials. Deliberately not an endpoint — an "MFA reset" route reachable without an
 * existing admin session is a second-factor bypass wearing a recovery label.
 *
 * WHAT IT DOES NOT DO. It does not mint a session, change a role, activate a suspended
 * admin, or touch the password-equivalent (there isn't one — login is OTP + TOTP). It
 * clears the seed and the enrolled flag TOGETHER, dropping the admin into the enrolment
 * branch of `verifyLogin`: their next successful email OTP issues a fresh secret. They must
 * still control the mailbox. Clearing only one of the two would be worse than nothing —
 * seed-without-flag leaves an admin the MFA gate never challenges.
 *
 * NOT SILENT. Unlike the bootstrap refusal, a reset is a security-relevant act on a live
 * account, so it prints who was reset and tells the operator to record it. The events spine
 * is not written from here (this process has no admin actor to attribute it to, and
 * fabricating one would put a lie on the audit trail) — the ROUTE is the audited path, and
 * this one is deliberately the exception that a human has to log by hand.
 *
 *   pnpm --filter @badabhai/db db:admin:reset-mfa -- --email ops@example.com
 *   pnpm --filter @badabhai/db db:admin:reset-mfa -- --email ops@example.com --apply
 */
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { createDbClient } from "./client";
import { hmacValue } from "./crypto";
import { adminUsers } from "./schema";

config();

const NAME = "admin:reset-mfa";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(`--${flag}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const pepper = process.env.PII_HASH_PEPPER;
  const missing = [!databaseUrl && "DATABASE_URL", !pepper && "PII_HASH_PEPPER"].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `missing required env: ${missing.join(", ")}. PII_HASH_PEPPER must be the value the ` +
        `API runs with, or the email will not resolve to any row.`,
    );
  }

  const rawEmail = argValue("email");
  if (!rawEmail) throw new Error("--email is required (the admin whose second factor to clear)");
  const email = rawEmail.trim().toLowerCase();
  const apply = process.argv.includes("--apply");

  const { db, sql } = createDbClient(databaseUrl!, { max: 1 });
  try {
    const emailHash = hmacValue(email, pepper!);
    const [admin] = await db
      .select({
        id: adminUsers.id,
        role: adminUsers.role,
        status: adminUsers.status,
        mfaEnrolled: adminUsers.mfaEnrolled,
      })
      .from(adminUsers)
      .where(eq(adminUsers.emailHash, emailHash))
      .limit(1);

    if (!admin) {
      // No enumeration concern here (this runs on a trusted shell, not a network surface),
      // so say plainly what happened — a silent no-op during an incident is cruel.
      console.log(
        `[${NAME}] no admin matches that email under the CURRENT PII_HASH_PEPPER. Check the ` +
          `address, and check you are running with the same pepper as the API.`,
      );
      return;
    }

    if (!admin.mfaEnrolled) {
      console.log(
        `[${NAME}] admin ${admin.id} has NO enrolled second factor — nothing to reset. ` +
          `They can log in with the email OTP alone and will be asked to enrol.`,
      );
      return;
    }

    if (!apply) {
      console.log(
        `[${NAME}] DRY RUN — would clear the second factor for:\n` +
          `[${NAME}]   admin=${admin.id} role=${admin.role} status=${admin.status}\n` +
          `[${NAME}] They would then re-enrol on their next successful email OTP.\n` +
          `[${NAME}] Re-run with --apply.`,
      );
      return;
    }

    // BOTH, in one statement. Split across two writes, a crash between them leaves either a
    // silent MFA bypass or a still-locked-out admin.
    await db
      .update(adminUsers)
      .set({ mfaSecretEnc: null, mfaEnrolled: false, updatedAt: new Date() })
      .where(eq(adminUsers.id, admin.id));

    console.log(
      `[${NAME}] second factor CLEARED for admin=${admin.id} role=${admin.role}.\n` +
        `[${NAME}] They re-enrol on their next successful email OTP — mailbox control is\n` +
        `[${NAME}] still required, so this does not by itself grant anyone access.\n` +
        `[${NAME}] RECORD THIS: who ran it, for whom, and why. This path is deliberately\n` +
        `[${NAME}] outside the audited admin route, so the audit trail is the one you write.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /reset-admin-mfa/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
