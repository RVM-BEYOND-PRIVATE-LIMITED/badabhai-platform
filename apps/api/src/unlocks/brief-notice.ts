import { BRIEF_CONTACT_NOTICE_VERSIONS } from "@badabhai/types";

/**
 * #2747 (ADR-0064 §3.8) — did this BadaBhai worker agree to the brief's contact rules?
 *
 * His LATEST consent row must be unrevoked, carry `employer_sharing`, and have been given on a
 * notice whose copy says what the brief does (`BRIEF_CONTACT_NOTICE_VERSIONS`): first name and
 * salary before paying, full name and phone after opening, open for good. On the 2026-11-04 notice
 * (14 days, initials, no name before unlock) the answer is no, and a company's pilot switches change
 * nothing for him. An actively linked RVM student is not asked this; the institute rule decides.
 *
 * Pure: the caller hands in the latest consent row it already read.
 */
export function onBriefNotice(
  latest:
    | {
        readonly consentVersion: string;
        readonly purposes: unknown;
        readonly revokedAt: Date | null;
      }
    | null
    | undefined,
  versions: readonly string[] = BRIEF_CONTACT_NOTICE_VERSIONS,
): boolean {
  if (!latest || latest.revokedAt !== null) return false;
  const purposes = Array.isArray(latest.purposes) ? (latest.purposes as unknown[]) : [];
  return purposes.includes("employer_sharing") && versions.includes(latest.consentVersion);
}
