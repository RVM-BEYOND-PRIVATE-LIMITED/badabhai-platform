/**
 * PACE supply-widening — the PURE widen decision (ADR-0021).
 *
 * Deterministic: a function of (supply, elapsed, current state, config) → the next
 * action. NO LLM, NO I/O, NO clock (elapsed hours is passed in, derived from an
 * injected clock by the caller). The service APPLIES the action (persist + emit +
 * schedule the next wave); this only DECIDES. Widening only ever ADDS candidates
 * (raises the travel band, or adds adjacency at the lower secondary weight) — it
 * never hides or drops anyone (sort-never-block + floor preserved).
 *
 * Escalation order is fixed: thin supply → widen AREA (in steps to the ceiling) →
 * [gated] widen ADJACENT trade → OPS ALERT once thin persists past the window.
 */

/** Current widen stage of a job's PACE run. */
export type PaceStage = "base" | "area" | "adjacent_trade" | "ops_alert";

/** Config-driven thresholds/steps — the rules; nothing is hard-coded in the logic. */
export interface PaceDecisionConfig {
  /** Supply below this (above-floor on-trade good-fit count) is "thin" → widen. */
  thinSupplyMin: number;
  /** Each AREA-widen wave raises the travel band by this many km. */
  areaStepKm: number;
  /** The ceiling the area band widens to. */
  maxAreaKm: number;
  /** Raise an ops alert once thin supply persists past this many elapsed hours. */
  opsAlertAfterHours: number;
  /** Whether the ADJACENT-TRADE leg is enabled — GATED on a ratified adjacency map
   * (no ratified map today → alpha=false; see ADR-0021). When false the leg is skipped. */
  adjacencyEnabled: boolean;
}

export interface PaceDecisionInput {
  /** Above-floor (on-trade `hot`) good-fit supply at the CURRENT band. */
  supplyCount: number;
  /** Hours since this PACE run began (derived from an injected clock by the caller). */
  elapsedHours: number;
  /** Current widen stage. */
  stage: PaceStage;
  /** Current AREA travel band (km). */
  currentAreaKm: number;
  /** Whether the ops alert was already raised (idempotency). */
  opsAlertRaised: boolean;
  config: PaceDecisionConfig;
}

export type PaceAction =
  | { kind: "none" } // supply healthy, or thin-but-waiting for the ops-alert window
  | { kind: "widen_area"; toAreaKm: number } // raise the travel band one step
  | { kind: "widen_adjacent" } // add adjacent-trade matches (gated, below on-trade)
  | { kind: "ops_alert" }; // thin past the window → human intervention (terminal)

/**
 * Decide the next PACE action. Pure + total: same inputs → same output, no side
 * effects. Exactly ONE lever escalates per call, in the fixed order.
 */
export function decidePaceAction(input: PaceDecisionInput): PaceAction {
  const { supplyCount, elapsedHours, stage, currentAreaKm, opsAlertRaised, config } = input;

  // Healthy supply → nothing to do. PACE only ever ADDS candidates; it never drops.
  if (supplyCount >= config.thinSupplyMin) return { kind: "none" };

  // Thin. Escalate exactly ONE lever, in order: AREA → [ADJACENT] → OPS ALERT.

  // 1. AREA first — raise the travel band by one step until the ceiling.
  if (currentAreaKm < config.maxAreaKm) {
    return {
      kind: "widen_area",
      toAreaKm: Math.min(currentAreaKm + config.areaStepKm, config.maxAreaKm),
    };
  }

  // 2. ADJACENT TRADE — only when enabled (GATED on a ratified map; alpha=false →
  //    skipped) and not already applied. Adjacent matches enter at the engine's lower
  //    secondary weight (below on-trade), so they ADD without out-ranking on-trade.
  if (config.adjacencyEnabled && stage !== "adjacent_trade") {
    return { kind: "widen_adjacent" };
  }

  // 3. OPS ALERT — all widening exhausted and still thin past the window. Once only.
  if (!opsAlertRaised && elapsedHours >= config.opsAlertAfterHours) {
    return { kind: "ops_alert" };
  }

  // Thin, but nothing to do yet (waiting for the ops-alert window). Re-checked next wave.
  return { kind: "none" };
}
