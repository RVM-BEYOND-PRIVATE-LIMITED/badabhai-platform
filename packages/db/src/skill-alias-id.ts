/**
 * Deterministic id for a skill_alias row (ADR-0030 / TAX-2).
 *
 * `skill_alias` has no unique(skill_id, text) constraint, so the seed's idempotency comes
 * from a STABLE, content-derived id: the same (skill_id, text, lang) always maps to the
 * same UUID, so re-seeding with `ON CONFLICT (id) DO NOTHING` is a no-op and never clobbers
 * an embedding a later phase (TAX-4) wrote. Pure + Node-only (used by the seed + tested).
 */
import { createHash } from "node:crypto";

export function deterministicAliasId(skillId: string, text: string, lang: string | null): string {
  const h = createHash("sha1")
    .update(`skill_alias:${skillId}:${lang ?? ""}:${text}`)
    .digest("hex");
  // Format the SHA-1 digest as a v5-shaped UUID (deterministic, not random).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
