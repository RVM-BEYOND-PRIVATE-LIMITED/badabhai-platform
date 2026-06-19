import { describe, it, expect } from "vitest";
import { decidePaceAction, type PaceDecisionConfig, type PaceDecisionInput } from "./pace.decision";

/** Default alpha-shaped config (adjacency GATED off — no ratified map). */
const CONFIG: PaceDecisionConfig = {
  thinSupplyMin: 3,
  areaStepKm: 15,
  maxAreaKm: 75,
  opsAlertAfterHours: 24,
  adjacencyEnabled: false,
};

function input(overrides: Partial<PaceDecisionInput> = {}): PaceDecisionInput {
  return {
    supplyCount: 0,
    elapsedHours: 0,
    stage: "base",
    currentAreaKm: 30,
    opsAlertRaised: false,
    config: CONFIG,
    ...overrides,
  };
}

describe("decidePaceAction — deterministic widen decision (ADR-0021)", () => {
  it("healthy supply → none (PACE only ADDS; it never widens when supply is enough)", () => {
    expect(decidePaceAction(input({ supplyCount: 3 })).kind).toBe("none");
    expect(decidePaceAction(input({ supplyCount: 99 })).kind).toBe("none");
  });

  it("thin supply → widen AREA by one step (capped at the ceiling)", () => {
    expect(decidePaceAction(input({ supplyCount: 0, currentAreaKm: 30 }))).toEqual({
      kind: "widen_area",
      toAreaKm: 45,
    });
    // Cap at maxAreaKm — never overshoots the ceiling.
    expect(decidePaceAction(input({ supplyCount: 1, currentAreaKm: 70 }))).toEqual({
      kind: "widen_area",
      toAreaKm: 75,
    });
  });

  it("widen AREA only ever RAISES the band (add-only; never narrows)", () => {
    const a = decidePaceAction(input({ supplyCount: 0, currentAreaKm: 30 }));
    expect(a.kind).toBe("widen_area");
    if (a.kind === "widen_area") expect(a.toAreaKm).toBeGreaterThan(30);
  });

  it("ESCALATION ORDER: area is exhausted to the ceiling BEFORE any later lever", () => {
    // Below the ceiling → always area, regardless of elapsed (area precedes ops alert).
    expect(decidePaceAction(input({ currentAreaKm: 60, elapsedHours: 48 })).kind).toBe("widen_area");
  });

  it("area maxed + adjacency OFF + past the window → OPS ALERT (terminal lever)", () => {
    expect(
      decidePaceAction(input({ currentAreaKm: 75, stage: "area", elapsedHours: 24 })).kind,
    ).toBe("ops_alert");
  });

  it("area maxed + adjacency OFF + BEFORE the window → none (wait, re-checked next wave)", () => {
    expect(
      decidePaceAction(input({ currentAreaKm: 75, stage: "area", elapsedHours: 12 })).kind,
    ).toBe("none");
  });

  it("ADJACENCY GATE: adjacent trade only fires when enabled (a ratified map) — and BEFORE ops alert", () => {
    const gatedOff = decidePaceAction(
      input({ currentAreaKm: 75, stage: "area", elapsedHours: 48, config: { ...CONFIG, adjacencyEnabled: false } }),
    );
    expect(gatedOff.kind).toBe("ops_alert"); // off → skipped entirely

    const gatedOn = decidePaceAction(
      input({ currentAreaKm: 75, stage: "area", elapsedHours: 48, config: { ...CONFIG, adjacencyEnabled: true } }),
    );
    expect(gatedOn.kind).toBe("widen_adjacent"); // on → adjacent BEFORE ops alert
  });

  it("does not re-widen adjacent once applied; escalates to ops alert after the window", () => {
    const next = decidePaceAction(
      input({
        currentAreaKm: 75,
        stage: "adjacent_trade",
        elapsedHours: 48,
        config: { ...CONFIG, adjacencyEnabled: true },
      }),
    );
    expect(next.kind).toBe("ops_alert");
  });

  it("never raises the ops alert twice (idempotent — opsAlertRaised guards it)", () => {
    expect(
      decidePaceAction(input({ currentAreaKm: 75, stage: "ops_alert", elapsedHours: 48, opsAlertRaised: true })).kind,
    ).toBe("none");
  });

  it("is deterministic — identical inputs yield an identical action", () => {
    const i = input({ supplyCount: 1, currentAreaKm: 45, elapsedHours: 10 });
    expect(decidePaceAction(i)).toEqual(decidePaceAction(i));
  });
});
