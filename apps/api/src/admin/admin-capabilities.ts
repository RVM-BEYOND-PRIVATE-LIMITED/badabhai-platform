import type { AdminRole } from "@badabhai/db";

/**
 * The admin RBAC capability model (ADR-0025 Decision 3) — the SINGLE SOURCE OF TRUTH for
 * "which role may do what". Deny-by-default: a capability is allowed ONLY if this matrix
 * explicitly lists the role under it; an unlisted capability, or a null/unknown role, is
 * DENIED (never defaulted to a privileged role).
 *
 * This constant is pinned against the ADR Decision-3 table by a drift test (must-fix #5) so
 * a silent over-grant fails CI. It is the ONLY place a capability→role mapping lives — guards
 * and (future ADMIN-2/3) routes consult {@link can}, never an inline check.
 */
export const ADMIN_CAPABILITIES = [
  "read_events",
  /**
   * Read the FACELESS entity projections (workers / payers / job postings / applications /
   * credit balances). ADR-0025 Decision 3.1 row 2, signed with the rest of the matrix but
   * never coded until BP-1, because until the Admin Portal there was no entity read route
   * to gate — the ops console reached those tables through `InternalServiceGuard` instead.
   *
   * It is DELIBERATELY NOT folded into `read_events`. The two cover different data classes:
   * `read_events` is the append-only audit spine (PII-free by registry construction),
   * `read_entities` is live system-of-record state. They happen to share the same allow-set
   * today, so conflating them would be invisible — right up until one of them needs to
   * narrow, at which point every route named for the wrong one moves with it.
   */
  "read_entities",
  /**
   * See the NAMES on an entity screen: `workers.full_name`, `payers.org_name_enc`,
   * `admin_users.name_enc`. ADR-0025 Decision 4 made every admin list faceless; the CTO
   * REVERSED that on 2026-08-18 because a console in which every row is an opaque uuid cannot
   * be used to operate the product.
   *
   * ── WHY IT IS ITS OWN CAPABILITY AND NOT PART OF `read_entities` ────────────────────────
   * Because `read_entities` is the read floor ALL FOUR roles hold, and its own docstring above
   * states the reason that is safe: "Faceless is what makes that safe." Names are a different
   * DATA CLASS — encrypted-at-rest PII, not ids/enums/timestamps/counts — so shipping them
   * under the same capability would silently widen what every existing holder of the floor can
   * see, and the published capability matrix (which `GET /admin/capabilities` serves to the
   * portal, and which ADR-0025 §3.1 pins) would be describing a grant it no longer makes.
   * A capability that has stopped meaning what its row says is worse than no capability at all:
   * it is an authorization table people still trust.
   *
   * `analyst` is DENIED (owner ruling): the analytics role has the floor and no identity.
   *
   * ── IT IS NOT ENFORCED BY A DECORATOR, AND THAT IS DELIBERATE ───────────────────────────
   * `@RequireAdminRole` sets exactly ONE capability per route ({@link
   * import("./admin-roles.guard").RequireAdminRole}) and `admin-static-guards.test.ts` asserts
   * exactly one per route, because a route with two gates has an ambiguous denial. The entity
   * routes must stay reachable on `read_entities` for every role — names are ADDITIVE to a
   * response that is otherwise unchanged — so the identity check is an explicit
   * `can(admin.role, "read_identity")` INSIDE {@link
   * import("./admin-identity.service").AdminIdentityService}, over the session admin the guard
   * already resolved. A role without it gets today's faceless response, byte for byte.
   */
  "read_identity",
  /**
   * DECRYPT one stored AI call trace — the prompt and the completion of a single call
   * (`GET /admin/ai-traces/:id`, migration 0083). `super_admin` ONLY.
   *
   * ── WHY IT IS NOT `reveal_pii`, WHICH IS THE OBVIOUS PLACE TO PUT IT ────────────────────
   * Because a capability is a promise about a DATA CLASS, and these are two different ones.
   * `reveal_pii` means "may see one worker's contact details on a reason-gated, single-subject,
   * flagged route", and it is held by `support` — the role whose job is calling a worker back.
   * Folding trace decryption into it would silently hand the entire support function the ability
   * to read what every worker has said in every interview, with nothing in the matrix, the ADR or
   * `GET /admin/capabilities` recording that the row had changed meaning. A capability that has
   * stopped meaning what its row says is worse than no capability at all.
   *
   * ── AND WHY IT IS NOT `read_entities` EITHER, WHICH IS WHERE THE LIST SITS ─────────────
   * The LIST beside it (`GET /admin/ai-traces`) is on the read floor, because it serves task
   * types, models, success flags and LENGTHS — the operational question ("which calls are
   * failing, how big are they") with none of the text. This capability gates only the step that
   * turns a length back into words. Splitting them is what stops ops work from costing a
   * worker's privacy, and it is the same separation `read_identity` makes against `read_entities`.
   *
   * ── SUPER_ADMIN ONLY, AND NARROWER THAN EVERY EXISTING PII ROW ─────────────────────────
   * `reveal_pii` discloses one field about one worker. This discloses everything one worker said
   * on one turn, from a table that holds every turn of every interview — and the plaintext inside
   * is NOT reliably pseudonymized (R32 measured the name gazetteer dead), which is precisely why
   * the schema encrypts it and why this row is the narrowest in the matrix. It sits with
   * `toggle_kill_switch` and `manage_admins` as break-glass. Widening it is a product decision
   * about who may read worker speech, and nobody has made one (CLAUDE.md §16).
   *
   * The capability is NOT sufficient on its own: the route is also behind the default-OFF
   * `ADMIN_AI_TRACE_READ_ENABLED` flag (a neutral 404 when off), a per-admin egress cap, and a
   * fail-closed `admin.ai_trace_viewed` audit row that must commit before any plaintext exists.
   */
  "read_ai_traces",
  "export",
  "suspend_payer",
  "grant_credits",
  "force_close_posting",
  "flag_worker",
  /**
   * RECORD a human review decision on one `skill_candidate` row (migration 0093): approve it as
   * a new canonical skill, as an alias of an existing skill, as a merge into one, reject it, or
   * hold it. `super_admin` + `ops_admin`.
   *
   * ── WHY IT IS ITS OWN CAPABILITY AND NOT ONE OF THE FOUR EXISTING WRITES ────────────────
   * Because every write row above is a promise about a different DATA CLASS: `suspend_payer` and
   * `force_close_posting` are entity moderation, `grant_credits` is money, `flag_worker` is a
   * worker's standing, `manage_admins` is admin identity. This is TAXONOMY AUTHORSHIP — the
   * vocabulary the deterministic match engine consumes when it decides which worker is shown
   * which job. Reusing `flag_worker` (the nearest-shaped existing grant) would hand authorship
   * of the platform's skill vocabulary to every holder of a worker-moderation grant as a SIDE
   * EFFECT, with nothing in this table, in ADR-0025 §3.1, or in what `GET /admin/me` serves
   * recording that the row had changed meaning. A capability that has stopped meaning what its
   * row says is worse than no capability at all: it is an authorization table people still trust.
   *
   * ── AND WHY IT IS NOT `read_entities`, WHICH IS WHERE THE QUEUE READS SIT ───────────────
   * The three reads beside it (queue list, candidate detail, queue metrics) ARE on the read
   * floor: they serve normalized phrases, enums, counts, provenance and a backlog age — the
   * operational question ("what is waiting, how old is the oldest thing nobody has opened").
   * This capability gates only the step that turns a queue row into a RECORDED DECISION.
   * Splitting them is what lets an `analyst` measure the review backlog without being entitled
   * to author the vocabulary, which is the same separation `read_ai_traces` makes against the
   * trace list one row up.
   *
   * ── IT IS NOT A PII ROW, SO IT IS DELIBERATELY NOT SHAPED LIKE ONE ─────────────────────
   * The obvious wrong answer is the `reveal_pii` allow-set (`support` + `super_admin`), because
   * `skill_candidate_source.original_text` can carry a worker's own words. It is refused.
   * `support` is the role that reveals one contact to help one worker and changes no platform
   * state; this surface is the exact inverse — it changes no worker's data and changes what the
   * matcher believes a skill IS. And the text needs no identity grant to work with: none of the
   * four 0093 tables has a `worker_id` column, the `worker_phrase` text is contractually
   * pseudonymized upstream, and the classifier's `FORBIDDEN_CHARS` check runs FIRST and rejects
   * any phrase carrying a digit, an `@` or a URL. Holding this must not imply holding identity,
   * and holding identity must not imply holding this.
   *
   * ── WHY `ops_admin` AND NOT super_admin-ONLY ───────────────────────────────────────────
   * The break-glass argument is real and worth stating: a decision here is IRREVERSIBLE in place
   * (the four terminal statuses can never be left — `canTransition` gives them no outbound edge,
   * because the decision was recorded against a specific `corpus_fingerprint` and re-opening the
   * row would silently re-scope it to a corpus the human never saw; a re-decision is a NEW
   * candidate in a NEW run). Irreversible plus platform-wide is the `toggle_kill_switch` shape.
   *
   * What settles it the other way is that this route CANNOT REACH THE CORPUS. An approval records
   * a decision on `skill_candidate` and nothing else; there is no request-path writer for `skill`,
   * `skill_alias` or `job_domain_skill` anywhere, and minting one stays in the offline guarded
   * chain (`validateTaxonomyCorpus` → `taxonomyQualityVerdict` → a human commit →
   * `db:seed:domain-skills` → `db:promote:skills` C1..C5), which carries its OWN human gate
   * downstream. So the blast radius of this write is one audited queue row plus a recommendation
   * a second human must still accept — the same class of governed queue work `flag_worker`
   * already grants to `ops_admin`. A `super_admin`-only review queue is a queue that stops, and
   * the review backlog is the throughput constraint on the whole taxonomy phase.
   *
   * `support` and `analyst` are DENIED: neither authors platform vocabulary.
   *
   * OWNER RULING STILL OWED: ADR-0025 §3.1's table has no row for this capability yet. The
   * allow-set above is the backend's reasoned default, not a signed cell — see the note on
   * `ADMIN_CAPABILITY_MATRIX` below.
   */
  "review_skill_candidates",
  "toggle_kill_switch",
  "reveal_pii",
  "manage_admins",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

/**
 * The capability→role matrix (ADR-0025 Decision 3.1). Each capability maps to the EXACT set
 * of roles allowed it. `read_events` is the read floor (all four roles); every mutation /
 * export / PII capability is least-privilege. DO NOT widen a row without updating the ADR
 * Decision-3 table (the drift test pins these together).
 *
 * Notes that encode the ADR's deliberate separations:
 *   - `export` excludes `support` (the PII-reveal role must NOT also bulk-export) and `analyst`.
 *   - `toggle_kill_switch` + `manage_admins` are `super_admin`-only (break-glass).
 *   - `reveal_pii` is `support` + `super_admin` ONLY (ops_admin/analyst denied).
 *   - `read_identity` is `super_admin` + `ops_admin` + `support` — a STRICT SUBSET of the
 *     `read_entities` floor, so it can only ever narrow what a role sees, never widen it.
 *   - `read_ai_traces` is `super_admin` ONLY, and is a strict subset of `reveal_pii` — the role
 *     that may read a worker's words is a role that may already reveal their phone, never the
 *     reverse.
 *   - `review_skill_candidates` is the governed-WRITE allow-set (`super_admin` + `ops_admin`),
 *     NOT the PII one: it authors the match vocabulary, it does not disclose anybody. It is also
 *     the ONE row in this table with no ADR §3.1 cell behind it yet.
 */
export const ADMIN_CAPABILITY_MATRIX: Record<AdminCapability, readonly AdminRole[]> = {
  read_events: ["super_admin", "ops_admin", "support", "analyst"],
  // ADR-0025 §3.1: "Read entities (workers/payers/jobs/postings — faceless, no PII)" — all
  // four roles, the same read floor as events. Faceless is what makes that safe: the
  // projections carry ids/enums/timestamps/counts, never a name, email, phone or ciphertext.
  read_entities: ["super_admin", "ops_admin", "support", "analyst"],
  // The NAMES behind those ids (owner ruling 2026-08-18, reversing Decision 4's faceless
  // contract). Three of the four roles — `analyst` is DENIED, so the analytics role keeps the
  // faceless floor and nothing more. Held by `ops_admin` even though `reveal_pii` is not: a
  // name on a screen you are already entitled to see is a different act from decrypting a
  // phone number on a reason-gated route, and the operator suspending a spam payer needs the
  // former to know which row to act on.
  read_identity: ["super_admin", "ops_admin", "support"],
  // Migration 0083 — DECRYPT a stored prompt/completion. SUPER_ADMIN ONLY, the narrowest row in
  // this table alongside `toggle_kill_switch` and `manage_admins`, and deliberately NOT held by
  // `support` even though `reveal_pii` is: revealing one worker's phone on a reason-gated route
  // and reading what every worker has said are different acts. See the capability's own docstring.
  read_ai_traces: ["super_admin"],
  export: ["super_admin", "ops_admin"],
  suspend_payer: ["super_admin", "ops_admin"],
  grant_credits: ["super_admin", "ops_admin"],
  force_close_posting: ["super_admin", "ops_admin"],
  flag_worker: ["super_admin", "ops_admin"],
  // Migration 0093 — RECORD a review decision on one skill candidate. The governed-write
  // allow-set, chosen by what the write can REACH: it moves one `skill_candidate` row and emits
  // one value-free action; the corpus itself is minted only by the offline chain, behind a second
  // human. `support` is denied because this is not a PII act, `analyst` because it is not a read.
  // NOT YET AN ADR CELL — see the capability's own docstring; widening or narrowing this row is an
  // owner decision (CLAUDE.md §16), and the drift test records that the ADR row is still owed.
  review_skill_candidates: ["super_admin", "ops_admin"],
  toggle_kill_switch: ["super_admin"],
  reveal_pii: ["super_admin", "support"],
  manage_admins: ["super_admin"],
} as const;

/**
 * Deny-by-default capability check. Returns true ONLY when `role` is a known role explicitly
 * listed under `capability` in the matrix. A null/undefined/unknown role → false (fail-closed).
 * An unknown capability → false (the lookup yields no allow-list).
 */
export function can(role: AdminRole | null | undefined, capability: AdminCapability): boolean {
  if (role === null || role === undefined) return false;
  const allowed = ADMIN_CAPABILITY_MATRIX[capability];
  return allowed !== undefined && allowed.includes(role);
}

/**
 * Every capability `role` holds — the server-resolved answer that `GET /admin/me` returns.
 *
 * WHY THIS EXISTS. The Admin Portal (ADMIN-4..8) has to render role-aware UI: hide the
 * suspend button from an analyst, hide reveal-contact from an ops_admin. The matrix lives
 * HERE, inside `apps/api` — a sibling app cannot import it. Without this the portal's only
 * options were to hardcode the role lists in the frontend or to guess, and a second copy of
 * an authorization table drifts the first time a row changes. So the server answers instead.
 *
 * DERIVED VIA {@link can}, deliberately — not by reading the matrix a second way. The guard
 * decides with `can`; this list is the same function over the same capability set, so what
 * the UI shows and what the server permits CANNOT disagree. Reimplementing the lookup here
 * would reintroduce exactly the drift this is meant to remove.
 *
 * This is a CONVENIENCE, never the enforcement. The server checks every request against
 * `@RequireAdminRole` regardless of what the client believes it may do; a client that forges
 * a longer list gets 403s, not access. Hiding a control the user cannot use is a UX act.
 */
export function capabilitiesFor(role: AdminRole | null | undefined): AdminCapability[] {
  return ADMIN_CAPABILITIES.filter((capability) => can(role, capability));
}
