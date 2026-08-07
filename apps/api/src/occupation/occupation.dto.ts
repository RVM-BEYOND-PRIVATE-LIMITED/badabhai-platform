/**
 * Wire contracts for the internal occupation routes.
 *
 * THE UTTERANCE ARRIVES ALREADY PSEUDONYMIZED and the bound below assumes it. 4,000
 * characters mirrors the ai-service's per-message pseudonymizer limit rather than its
 * 20,000-character whole-transcript limit — the defect that made `/profile/extract` fail
 * closed on any verbose interview was exactly a bound set against the wrong unit.
 */
import { z } from "zod";

export const ResolveOccupationDtoSchema = z.object({
  text: z.string().min(1).max(4000),
  lang: z.string().min(2).max(8).optional(),
  /**
   * A query embedding the caller already holds. This service never mints one — see
   * `occupation.service.ts`. 768 dims to match the seeded corpus; a wrong width is a
   * caller bug and is rejected rather than silently scoring as noise.
   */
  vector: z.array(z.number()).length(768).optional(),
  allow_vector: z.boolean().optional(),
});
export type ResolveOccupationDto = z.infer<typeof ResolveOccupationDtoSchema>;
