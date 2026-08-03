/**
 * ADR-0038 — first-super-admin bootstrap.
 *
 * THE PROBLEM THIS SOLVES. `admin_users` rows are created by `POST /admin/invite`, which is
 * itself behind `AdminAuthGuard` + the `manage_admins` capability. So creating the first
 * admin requires an authenticated admin: a closed loop with no entry point. The whole
 * ADMIN-3a surface — guards, capability matrix, `admin.action_performed` — shipped complete
 * and unreachable.
 *
 * WHY A CLI AND NOT AN HTTP ENDPOINT. A bootstrap endpoint is a permanent unauthenticated
 * route that mints a super_admin. Even guarded by "only if none exists" it is one logic bug
 * away from total compromise, it must be exposed on the public listener, and it is
 * indistinguishable in the access log from an attack. A CLI requires shell access to the
 * deployment and DB credentials — a materially higher bar than an HTTP request, and one the
 * attacker who has it does not need this endpoint for.
 *
 * ONE-TIME BY CONSTRUCTION. It refuses if ANY `super_admin` row exists — in ANY status.
 * Not just `active`: allowing it to run while the only super_admin is `suspended` would make
 * "suspend the super_admin, then bootstrap a new one" a privilege-escalation path for anyone
 * with shell access, which is exactly the population this is supposed to bound. Every
 * subsequent admin comes from the invite flow.
 *
 * NO HARDCODED EMAIL (owner ruling 2026-08-03). The address is an argument, so the same
 * build bootstraps any deployment and no environment-specific identity is baked into the
 * image or the repo.
 *
 * PII: the email and name are encrypted at rest with the SAME keyring the API uses
 * (ADR-0004); the email also carries the keyed HMAC that is the login lookup key. Neither
 * plaintext is ever logged — the console output carries the opaque admin id and an 8-char
 * hash prefix only.
 *
 *   pnpm --filter @badabhai/db db:bootstrap:admin -- --email ops@example.com --name "Asha R"
 *   pnpm --filter @badabhai/db db:bootstrap:admin -- --email ops@example.com --with-totp
 *
 * (DATABASE_URL, PII_ENCRYPTION_KEY and PII_HASH_PEPPER must be set — the same values the
 * API runs with, or the row it writes will not authenticate.)
 */
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { createDbClient, type Database } from "./client";
import { encryptPii, hmacValue } from "./crypto";
import { adminUsers } from "./schema";

config();

const NAME = "bootstrap:admin";

/** Read a `--flag value` argument. Returns null when absent. */
function argValue(flag: string): string | null {
  const i = process.argv.indexOf(`--${flag}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function argFlag(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

/**
 * Deliberately STRICTER than a full RFC 5322 parse. This value becomes the login key for
 * the most privileged account on the platform, and a bootstrap that silently accepts a
 * typo'd or whitespace-padded address produces an account nobody can log into — with no
 * second chance, because the CLI then refuses to run again.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new Error(`not a valid email address: ${JSON.stringify(raw)}`);
  }
  return email;
}

/** RFC 4648 base32, no padding — the alphabet Google Authenticator / Authy expect. */
export function base32Encode(buf: Buffer): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * THE ONE-TIME GATE. Returns any existing `super_admin`, which is what makes this CLI
 * refuse to run twice.
 *
 * `role = 'super_admin'` is the ONLY predicate — status is deliberately absent. Filtering
 * to `active` would let "suspend the super_admin, then bootstrap a new one" become a
 * privilege-escalation path for anyone holding shell access, which is precisely the
 * population this gate exists to bound. A suspended root account must block a second one.
 */
export async function findAnySuperAdmin(
  db: Database,
): Promise<{ id: string; status: string }[]> {
  return db
    .select({ id: adminUsers.id, status: adminUsers.status })
    .from(adminUsers)
    .where(eq(adminUsers.role, "super_admin"))
    .limit(1);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKey = process.env.PII_ENCRYPTION_KEY;
  const pepper = process.env.PII_HASH_PEPPER;

  // Fail CLOSED and specifically. A missing key here does not produce a broken row — it
  // produces a row encrypted under the wrong secret, which looks fine until login fails.
  const missing = [
    !databaseUrl && "DATABASE_URL",
    !encryptionKey && "PII_ENCRYPTION_KEY",
    !pepper && "PII_HASH_PEPPER",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `missing required env: ${missing.join(", ")}. These MUST be the same values the API ` +
        `runs with — a row written under a different key or pepper cannot be logged into.`,
    );
  }

  const rawEmail = argValue("email");
  if (!rawEmail) {
    throw new Error(
      "--email is required. The first super_admin's address is an ARGUMENT, never a " +
        "hardcoded constant, so one build bootstraps any deployment.",
    );
  }
  const email = normalizeEmail(rawEmail);
  const name = argValue("name");
  const withTotp = argFlag("with-totp");
  const apply = argFlag("apply");

  const { db, sql } = createDbClient(databaseUrl!, { max: 1 });
  try {
    const existing = await findAnySuperAdmin(db);

    if (existing.length > 0) {
      const row = existing[0]!;
      console.log(
        `[${NAME}] REFUSED — a super_admin already exists (id=${row.id} status=${row.status}).\n` +
          `[${NAME}] This CLI bootstraps the FIRST one only. Create further admins through ` +
          `POST /admin/invite, which is audited and capability-gated.\n` +
          `[${NAME}] If that admin is locked out, reinstate or re-invite them — do not ` +
          `bootstrap a second root account.`,
      );
      // Exit 0, not 1: on a re-run of a deployment script this is the EXPECTED outcome, and
      // a non-zero exit would fail a pipeline that is behaving correctly. The refusal is the
      // success case for every run after the first.
      return;
    }

    const emailHash = hmacValue(email, pepper!);
    const hashPrefix = emailHash.slice(0, 8);

    if (!apply) {
      console.log(
        `[${NAME}] DRY RUN — no super_admin exists, so this WOULD create one.\n` +
          `[${NAME}]   email_hash=${hashPrefix}… (the address itself is never printed)\n` +
          `[${NAME}]   name=${name ? "provided" : "(none)"}  totp=${withTotp ? "yes" : "no"}\n` +
          `[${NAME}] Re-run with --apply to write it.`,
      );
      return;
    }

    // FULLY INITIALIZED: role=super_admin AND status='active'. The invite flow deliberately
    // creates `pending` admins that an existing admin then activates — but there is no
    // existing admin to do that here, so a `pending` bootstrap would recreate the very
    // deadlock this CLI exists to break.
    const [created] = await db
      .insert(adminUsers)
      .values({
        emailEnc: encryptPii(email, encryptionKey!),
        emailHash,
        nameEnc: name ? encryptPii(name, encryptionKey!) : null,
        role: "super_admin",
        status: "active",
        mfaEnrolled: false,
      })
      .returning({ id: adminUsers.id });

    if (!created) throw new Error("insert returned no row");

    console.log(
      `[${NAME}] created the first super_admin id=${created.id} email_hash=${hashPrefix}… status=active`,
    );

    if (withTotp) {
      const secret = base32Encode(randomBytes(20));
      const label = encodeURIComponent(`BadaBhai:${created.id}`);
      const params = new URLSearchParams({
        secret,
        issuer: "BadaBhai",
        algorithm: "SHA1",
        digits: "6",
        period: "30",
      });
      const otpauthUri = `otpauth://totp/${label}?${params.toString()}`;

      // Written ENCRYPTED to `admin_users.mfa_secret_enc` — the SAME column
      // `AdminMfaSecretStore` reads, under the same AES-256-GCM key. It goes to the
      // database rather than Redis deliberately (ADR-0038): the old Redis key had no TTL
      // and no persistence guarantee, so a flush would have destroyed a seed that is shown
      // once and never recoverable.
      //
      // One statement, and `mfa_enrolled` is flipped in the SAME update: a seed stored
      // without the flag would leave an admin the MFA gate never challenges, and the flag
      // without a seed would lock them out. Neither half is useful alone.
      await db
        .update(adminUsers)
        .set({
          mfaSecretEnc: encryptPii(secret, encryptionKey!),
          mfaEnrolled: true,
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.id, created.id));
      console.log(`[${NAME}] TOTP seed stored (encrypted at rest); mfa_enrolled=true`);

      // Printed ONCE, to stdout, deliberately. There is no other way to hand a TOTP seed to
      // a human, and it is never recoverable afterwards (stored encrypted, never returned).
      console.log(
        `\n[${NAME}] ── SCAN THIS NOW; IT IS NOT SHOWN AGAIN ──\n` +
          `[${NAME}] ${otpauthUri}\n` +
          `[${NAME}] secret: ${secret}\n` +
          `[${NAME}] ────────────────────────────────────────────\n`,
      );
    }

    console.log(
      `[${NAME}] done. Every further admin must come from POST /admin/invite — this CLI ` +
        `will refuse from now on.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when EXECUTED, never when imported — the unit tests import the helpers above
// and must not open a database connection as a side effect.
if (process.argv[1] && /bootstrap-admin/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
