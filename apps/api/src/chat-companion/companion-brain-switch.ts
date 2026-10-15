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

/** The flags that decide whether WP6's route precedence runs. */
export type CompanionPrecedenceFlags = CompanionBrainFlags &
  Pick<ServerConfig, "CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED">;

/**
 * DOES WP6's ROUTE PRECEDENCE RUN? (TD146; ADR-0055 R1, owner ruling 2026-10-15 "brain first") — the
 * one definition the service's routing and the orchestrator's pending intent both read.
 *
 * Its own flag turns it on as before; so does the free-chat brain. While the brain is on, a message
 * v1 would only have answered through a WEAK alias (a résumé word, a menu alias or section word, a
 * greeting, the bare "kaam") goes to the brain, an edit phrasing goes straight to the edit handler,
 * and a pending task-chip intent routes the next message — the WP6 order, reused, not forked. Exact
 * chips and every NAMED v1 intent (jobs, applications, guarantee, status) keep their own answers.
 * With the kill switch on and the flag off it is off, and the flow is today's byte for byte.
 */
export function companionRoutePrecedenceOn(config: CompanionPrecedenceFlags): boolean {
  return (
    config.CHAT_COMPANION_V2_ENABLED === true &&
    (config.CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED === true || companionBrainOn(config))
  );
}
