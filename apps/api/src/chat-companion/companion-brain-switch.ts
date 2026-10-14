import type { ServerConfig } from "@badabhai/config";

/** The two flags that decide whether the Bada Bhai chat runs the free-chat brain. */
export type CompanionBrainFlags = Pick<
  ServerConfig,
  "CHAT_COMPANION_V2_ENABLED" | "CHAT_FREE_CHAT_DISABLED"
>;

/**
 * DOES THE BADA BHAI CHAT RUN THE FREE-CHAT BRAIN? (ADR-0055, #2275) — read here and nowhere else.
 *
 * LIVE ON MERGE, WITH NO FLAG OF ITS OWN (owner ruling 2026-10-14). The brain rides the companion's
 * existing model gate, `CHAT_COMPANION_V2_ENABLED` (off is v1, the deterministic ADR-0044 tab, with
 * no model at all), and its ONE lever is the profiling free chat's existing kill switch,
 * `CHAT_FREE_CHAT_DISABLED`: true sends this screen back to today's v2 path byte for byte — the
 * companion classifier, the career handler, the shipped résumé menu — exactly as it sends the
 * profiling chat back to its pre-ADR-0051 interview. A key that is absent reads as false (the
 * feature on), the same reading `booleanFromString` gives an unset variable.
 */
export function companionBrainOn(config: CompanionBrainFlags): boolean {
  return config.CHAT_COMPANION_V2_ENABLED === true && config.CHAT_FREE_CHAT_DISABLED !== true;
}
