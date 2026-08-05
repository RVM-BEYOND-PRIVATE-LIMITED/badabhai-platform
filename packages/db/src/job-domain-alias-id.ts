/**
 * Deterministic id for a `job_domain_alias` row (migration 0060).
 *
 * Same idempotency device as `skill-alias-id.ts`, and for the same reason:
 * `job_domain_alias` has no unique(job_domain_id, text) constraint, so the seed's
 * idempotency comes from a STABLE, content-derived id. The same
 * (job_domain_id, text, lang) always maps to the same UUID, so re-seeding with
 * `ON CONFLICT (id) DO NOTHING` is a no-op — and, critically, never clobbers an
 * embedding that `pnpm db:embed:domains` already paid a real provider call for.
 *
 * DELIBERATELY A SEPARATE FUNCTION, NOT A PARAMETERISED `deterministicAliasId`.
 * The hash namespace prefix differs (`job_domain_alias:` vs `skill_alias:`), which is
 * what makes a collision between the two id spaces provably impossible rather than
 * merely unlikely. Generalising the existing helper to take a prefix would leave one
 * argument standing between the two tables sharing a UUID — and since both are
 * `ON CONFLICT (id) DO NOTHING`, a collision would silently DROP a row rather than
 * error. Copy the eight lines; keep the guarantee structural.
 *
 * Pure + Node-only (used by the seed + tested).
 */
import { createHash } from "node:crypto";

export function deterministicJobDomainAliasId(
  jobDomainId: string,
  text: string,
  lang: string | null,
): string {
  const h = createHash("sha1")
    .update(`job_domain_alias:${jobDomainId}:${lang ?? ""}:${text}`)
    .digest("hex");
  // Format the SHA-1 digest as a v5-shaped UUID (deterministic, not random).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
