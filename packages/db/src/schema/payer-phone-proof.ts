import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { payers } from "./payer";

// ---------------------------------------------------------------------------
// payer_phone_proofs — a company PROVED it holds the phone on its account (#2754 item 3).
//
// THE RULE LIVES HERE, NOT ON `payers.phone_hash`. A company's phone is a sign-in credential
// (an SMS code can sign it in) only while a proof row exists whose `phone_hash` equals the
// account's CURRENT `payers.phone_hash`. A phone typed at sign-up or in `PATCH /payer/me` is
// stored unproven; it becomes a credential only once the signed-in company has entered a code
// sent to it (`POST /payer/me/phone-proof/verify`, method `sms_code`), or an imported Campus
// company brings Campus's own OTP-verified sign-in phone (method `campus_import`).
//
// ONE ACCOUNT PER PROVEN PHONE. `payer_phone_proofs_phone_hash_uq` lets only ONE account ever
// hold the proof of a phone, so an SMS sign-in can never land in the wrong account. It is on the
// PROOF, not on `payers.phone_hash`: production may already hold two accounts on one phone, and
// a unique index there would fail to apply (and refusing the duplicate at sign-up would leak that
// the phone has an account). Those duplicates keep email sign-in until they are resolved by hand
// (`report-shared-payer-phones.cli.ts`); a payers-level unique index is a later owner step.
//
// A PHONE CHANGE DROPS THE PROOF in the same transaction (`PayersRepository.update`), so a new
// number starts unproven. A stale row (its hash no longer the account's) is ignored by every
// read anyway. Archive and suspend leave the proof in place; the sign-in status checks refuse
// those accounts, and a restore brings the proof back with the account.
//
// OPAQUE ONLY: the payer id, a keyed HMAC of the phone (the same `hashPhone` as `payers`), a
// closed method code and a time. Never the number. `payer_id` cascades on the hard delete of
// the account (DPDP erasure). RLS forced, every role revoked (hand-written tail of the migration).
// ---------------------------------------------------------------------------

/** How a phone was proven. A new value is a CHECK change and a new event version. */
export const PAYER_PHONE_PROOF_METHODS = ["sms_code", "campus_import"] as const;
export type PayerPhoneProofMethod = (typeof PAYER_PHONE_PROOF_METHODS)[number];

export const payerPhoneProofs = pgTable(
  "payer_phone_proofs",
  {
    /** The account that proved the phone: at most one proof per account. Cascades on erasure. */
    payerId: uuid("payer_id")
      .primaryKey()
      .references(() => payers.id, { onDelete: "cascade" }),
    /** `hashPhone` of the proven number — the same keyed HMAC as `payers.phone_hash`. */
    phoneHash: text("phone_hash").notNull(),
    /** `PAYER_PHONE_PROOF_METHODS`. */
    method: text("method").$type<PayerPhoneProofMethod>().notNull(),
    provenAt: timestamp("proven_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ONE ACCOUNT PER PROVEN PHONE: the SMS sign-in lookup and the proof insert both key on it.
    uniqueIndex("payer_phone_proofs_phone_hash_uq").on(t.phoneHash),
    // `PAYER_PHONE_PROOF_METHODS`, spelled out because a CHECK is static SQL.
    check("payer_phone_proofs_method_chk", sql`${t.method} IN ('sms_code', 'campus_import')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type PayerPhoneProof = typeof payerPhoneProofs.$inferSelect;
export type NewPayerPhoneProof = typeof payerPhoneProofs.$inferInsert;
