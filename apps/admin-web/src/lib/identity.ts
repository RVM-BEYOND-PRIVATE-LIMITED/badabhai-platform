/**
 * How this console renders the ONE identity field its entity reads now carry.
 *
 * Owner ruling 2026-08-18 reversed ADR-0025 Decision 4: worker names on the workers list AND
 * detail, organisation names on companies/agencies, admin names on the directory. The console
 * was unusable while every row was an opaque uuid.
 *
 * ── THE SERVER'S CONTRACT IS THREE-VALUED, AND THIS FILE IS WHY THAT MATTERS ─────────────
 * `admin-entities.dto.ts` and `admin-identity.service.ts` define the name field as OPTIONAL,
 * and its presence is itself an answer:
 *
 *   key ABSENT   — nothing was disclosed on this response.
 *   key NULL     — disclosed, and no name came back: either none is recorded, or the stored one
 *                  did not decrypt (the server degrades a failed decrypt to null rather than
 *                  500ing an operations list). WHICH of the two depends on the column: it is
 *                  almost always the former on `workers`/`admin_users`, whose name columns are
 *                  NULLABLE, and can only be the latter on `payers`, whose `org_name_enc` is
 *                  `NOT NULL`. See NO_NAME_ON_RECORD / NAME_UNREADABLE at the bottom of the file.
 *   key STRING   — the stored name, decrypted for this one response.
 *
 * Collapsing absent into null is the specific mistake worth preventing. A dash under a "Name"
 * heading reads as "this person has no name on record" — so painting one for a row whose name
 * was never disclosed puts a lie shaped like data on an operations screen. The backend refuses
 * to do it (over its 50-name bound it discloses NOTHING rather than naming the first fifty);
 * this file is the client half of the same refusal.
 *
 * ── THE FOURTH STATE THE PORTAL KNOWS ON ITS OWN ────────────────────────────────────────
 * The server deliberately answers `null` for all three withholding reasons, because the caller's
 * job is identical in each: serve the faceless projection. The client tells them apart because
 * `GET /admin/me` already says whether this session holds `read_identity`:
 *
 *   key present anywhere   ⇒ NAMED     — render the name column
 *   absent + entitled      ⇒ CAPPED    — this READ was refused (hourly name budget, or a set
 *                                        larger than the server's 50-name response bound)
 *   absent + not entitled  ⇒ FACELESS  — this ROLE never sees names (`analyst`)
 *
 * The three drive genuinely different screens, which is the whole point of separating them:
 * FACELESS renders the pre-ruling console exactly as it shipped — no name column, no dashes, no
 * promise of data this operator will never see. CAPPED keeps the column OFF too, and says why,
 * because a column of dashes is precisely the lie above.
 *
 * ── AND THE POSTURE IS MEASURED, NOT PREDICTED ──────────────────────────────────────────
 * `identityPosture` decides NAMED from the rows that actually arrived, never from the
 * capability. If the two ever disagree — a server that disclosed to a role `/admin/me` says is
 * not entitled — the names are already over the wire and hiding the column would not un-disclose
 * them; what the portal must not do is claim in copy that nothing was shown while showing it.
 */

/** What this session may be shown, as this response actually turned out. */
export type IdentityPosture = "named" | "capped" | "faceless";

/**
 * Was a name DISCLOSED for this row? Key PRESENCE is the answer, never the value — a `null`
 * name is a disclosed answer ("nobody recorded one"), not an absence.
 */
export function nameDisclosed(row: object, field: string): boolean {
  return Object.hasOwn(row, field);
}

/**
 * The posture for a whole response.
 *
 * `rows` is the page as parsed; `field` is the name key on that shape (`full_name`, `org_name`
 * or `name`); `entitled` is `can(session.capabilities, "read_identity")`.
 *
 * Disclosure is all-or-nothing per response — the identity service resolves the whole set or
 * refuses it — so ANY row carrying the key means the read was named. `some` rather than `every`
 * regardless: a partially-named page would be a server-side contract break, and reading it as
 * NAMED renders the names that did arrive while `displayName` dashes the rest, which beats
 * declaring the whole page capped and hiding real disclosures that already happened.
 *
 * An EMPTY entitled page is NAMED. Nothing was withheld — there was nothing to withhold — and
 * the alternative would post a "names are withheld" warning over a table with no rows in it. No
 * column is rendered for zero rows either way, so this only decides the copy, and "your role
 * sees names" is the true statement about an entitled session looking at an empty list.
 */
export function identityPosture(
  rows: readonly object[],
  field: string,
  entitled: boolean,
): IdentityPosture {
  if (rows.some((row) => nameDisclosed(row, field))) return "named";
  if (!entitled) return "faceless";
  return rows.length === 0 ? "named" : "capped";
}

/**
 * The name to print for one row, or `null` for the honest dash.
 *
 * BLANK IS ABSENT. `workers.full_name` is worker-entered free text and `payers.org_name_enc` is
 * self-declared at signup, so `"   "` is a value the database can genuinely hold. Printed
 * verbatim it renders as an empty cell — a row that has silently lost its label, which is the
 * layout collapse this function exists to stop. Trimmed to nothing, it takes the same dash as a
 * null: "we have no usable name for this row" is exactly what both facts mean to an operator.
 *
 * The trim is display-only and never sent back anywhere — nothing in this portal writes a name.
 */
export function displayName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Hover copy for the dash, on a surface whose name column is NULLABLE.
 *
 * `workers.full_name` and `admin_users.name_enc` are both nullable, and both are routinely
 * unset — the admin invite flow never collects a name at all — so on those two surfaces "nobody
 * recorded one" is the overwhelmingly likely truth and is what the dash should say.
 */
export const NO_NAME_ON_RECORD = "No name on record for this account.";

/**
 * Hover copy for the dash on a NOT-NULL name column — today only `payers.org_name_enc`.
 *
 * `packages/db/src/schema/payer.ts` declares `org_name_enc` as `.notNull()`, and
 * `payers.repository.ts` always writes a ciphertext on signup, so a payer with no org name is a
 * row that cannot exist. A dash here therefore does NOT mean "none was recorded" — the only
 * things it can mean are that the stored ciphertext failed to decrypt (a retired or rotated
 * key, a kid missing from the keyring, corruption — `AdminIdentityService.decryptOrNull`
 * degrades all three to `null`) or that the stored name is blank whitespace.
 *
 * Printing NO_NAME_ON_RECORD here would tell an operator that a paying customer never supplied
 * a name, when the truth is that the platform can no longer read the one it holds — a difference
 * that matters on a screen with a suspend button on it.
 */
export const NAME_UNREADABLE = "No readable name is stored for this account.";
