/**
 * Identity-masking for the EMPLOYER-facing resume disclosure (decision eafcccc /
 * docs/security/resume-disclosure-threat-model-addendum.md, build gate **B-G**).
 *
 * The worker's OWN resume keeps the real name (TD21, unchanged). The employer-facing
 * disclosure is identity-MASKED: the renderer is fed `displayName = maskInitials(realName)`,
 * computed SERVER-SIDE at the moment of disclosure. The real name is read once, passed
 * here, and NEVER logged / evented / persisted into the disclosure record (the caller +
 * resume-renderer.service.ts own that no-PII guarantee). Phone is NOT part of the
 * employer resume at all — contact stays the separate paid unlock (ADR-0010).
 *
 * RULE (matches the decision's golden example exactly):
 *   - the FIRST name keeps its leading letter; the rest of that token becomes '*'
 *     (one star per remaining character);
 *   - every SUBSEQUENT name collapses to "<initial>.".
 *
 *   "Ramesh Kumar"  -> "R***** K."     (the decision's canonical example)
 *   "Ravi"          -> "R***"
 *   "asha   kumari" -> "A*** K."        (case-normalised initials, whitespace-collapsed)
 *
 * STILL PERSONAL DATA: masked initials remain a weak identifier — expanding the mask
 * (more letters, adding the surname, etc.) needs a fresh consent tier + a threat-model
 * revision (decision eafcccc). Do not loosen this without that gate.
 *
 * RESIDUAL (documented, accepted by the decision's golden render): the star count
 * reveals the first name's length. Accepted for alpha; revisit with B-G hardening.
 *
 * PURE + PII-SAFE: a deterministic string transform that only ever REDUCES the name.
 * No I/O, no logging, no throw — `null`/empty/whitespace-only → `null` so the caller
 * renders a name-less resume rather than leaking a fallback.
 */
export function maskInitials(fullName: string | null | undefined): string | null {
  if (fullName == null) return null;
  const tokens = fullName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const first = tokens[0]!; // length >= 1 guaranteed above
  const rest = tokens.slice(1);
  const firstInitial = first[0]!.toUpperCase();
  // First token: initial + one '*' per remaining character (length residual, accepted).
  const firstMasked = first.length <= 1 ? firstInitial : firstInitial + "*".repeat(first.length - 1);
  // Subsequent tokens: initial + "." only — never a length signal.
  const restMasked = rest.map((t) => `${t[0]!.toUpperCase()}.`);

  return [firstMasked, ...restMasked].join(" ");
}
