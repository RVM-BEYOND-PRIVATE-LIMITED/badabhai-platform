import type { z } from "zod";
import {
  CAMPUS_TARGETING_LIMITS,
  type CampusTargetingOptionsBodySchema,
} from "./campus-link.contract";

/** Devanagari letter KA, from its code point: 3 bytes in UTF-8, as every Indian script letter. */
const KA = String.fromCharCode(0x0915);

/**
 * #2746 PR 5 — the LARGEST `PUT targeting-options` body the schema accepts, in plain UTF-8: every
 * list at its cap, every label at its length in a 3-byte script, every course id 64 three-byte
 * characters (unique by a numeric tail), the largest branch ids. The contract test proves it fits
 * the api's 100 kB JSON limit; the HTTP test proves the real body parser takes it.
 */
export function largestTargetingBody(
  asOf = "2026-11-14T10:00:00.000000+05:30",
): z.input<typeof CampusTargetingOptionsBodySchema> {
  const L = CAMPUS_TARGETING_LIMITS;
  return {
    as_of: asOf,
    branches: Array.from({ length: L.branches }, (_, i) => ({
      id: L.maxBranchId - i,
      name: KA.repeat(L.labelLength),
    })),
    courses: Array.from({ length: L.courses }, (_, i) => ({
      id: KA.repeat(61) + String(i).padStart(3, "0"),
      name: KA.repeat(L.labelLength),
    })),
  };
}
