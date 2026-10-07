/**
 * ADR-0050 §10 Q3 — the two fixed values every agency-job twin carries.
 *
 * A twin is a SYSTEM-OWNED `job_postings` row (payer_id NULL, C2) derived from an agency `jobs`
 * row. Two of its NOT NULL columns have nothing to derive from:
 *
 *   - `created_by` — the opaque actor id. A twin is written by the sync alone, so it carries ONE
 *     fixed system actor, never an agent's or an admin's id.
 *   - `org_label` — `jobs` is faceless by design (ADR-0009 §2), so there is no employer name to
 *     copy, and inventing one would put employer identity on a faceless row. A twin carries ONE
 *     neutral label that is never projected to a worker (the V1 feed does not select it).
 *
 * D4 demands both as CLI arguments because it runs once. A continuous sync needs them as
 * reviewed CONFIGURATION, never per-run guesses, so they live here as constants (not env: a
 * value that differs per environment would make twins differ per environment for no reason).
 *
 * BOTH ARE CHECKED AT BOOT by the api's agency-twin module (uuid shape; the label runs the
 * PII / org-name / URL screens) and by the `db:sync:agency-twins` CLI before it writes, so a
 * bad edit here fails closed instead of reaching a row.
 *
 * CHANGING EITHER is a reviewed code change: the sync then rewrites `org_label` on every twin
 * on its next pass (it is a synced column); `created_by` is written at insert only.
 */

/** The fixed system actor stamped as `job_postings.created_by` on every agency twin. */
export const AGENCY_TWIN_SYSTEM_ACTOR_ID = "c01de5e9-f3d7-4089-befd-2b4a4cda3829";

/**
 * The fixed, NEUTRAL `job_postings.org_label` of every agency twin. Never a real employer name,
 * never a contact, never a link — and never on a worker read.
 */
export const AGENCY_TWIN_ORG_LABEL = "Agency vacancy";
