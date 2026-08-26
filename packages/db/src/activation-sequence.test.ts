/**
 * The activation sequence — and the assertions that stop it from becoming a wish.
 *
 * The failure mode of an activation plan is always the same: a step quietly loses its
 * precondition, the ordering shifts, and someone follows the old page. So the preconditions are
 * graph item ids rather than prose, and the tests below check the two things a plan can be
 * wrong about — that a step's inputs exist, and that nothing precedes what it depends on.
 *
 * The last group is the one that matters most: **nothing in this file activates anything**, and
 * that is asserted by reading the file's own source rather than believed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_SEQUENCE,
  readyNow,
  stopsAt,
  validateSequence,
  type ActivationStep,
} from "./activation-sequence";
import { PROGRAMME, type ProgrammeItem } from "./programme-graph";

const step = (o: Partial<ActivationStep> & { order: number; id: string }): ActivationStep => ({
  what: "w",
  runner: null,
  preconditions: [],
  after: [],
  authorisation: "NONE",
  verification: "v",
  rollback: null,
  ...o,
});

describe("validateSequence", () => {
  it("accepts a coherent plan", () => {
    expect(
      validateSequence([step({ order: 1, id: "A" }), step({ order: 2, id: "B", after: ["A"] })], []),
    ).toEqual([]);
  });

  it("refuses a step that must come after one ordered later", () => {
    const p = validateSequence(
      [step({ order: 1, id: "A", after: ["B"] }), step({ order: 2, id: "B" })],
      [],
    );
    expect(p[0]?.problem).toMatch(/must come after B/);
  });

  it("refuses a precondition that is not a real programme item", () => {
    const p = validateSequence([step({ order: 1, id: "A", preconditions: ["ghost"] })], []);
    expect(p[0]?.problem).toMatch(/unknown precondition ghost/);
  });

  it("refuses a production write with no rollback", () => {
    // Without one the plan is a list of commands, not a procedure.
    const p = validateSequence([step({ order: 1, id: "A", authorisation: "PRODUCTION_WRITE" })], []);
    expect(p[0]?.problem).toMatch(/no rollback/);
  });

  it("refuses a step that runs --apply while claiming to need no authorisation", () => {
    const p = validateSequence(
      [step({ order: 1, id: "A", runner: "pnpm x --apply", authorisation: "NONE" })],
      [],
    );
    expect(p[0]?.problem).toMatch(/claims to need no authorisation/);
  });

  it("refuses a renumbered plan", () => {
    const p = validateSequence([step({ order: 3, id: "A" })], []);
    expect(p[0]?.problem).toMatch(/order 3 at index 0/);
  });
});

describe("readyNow and stopsAt", () => {
  const items: ProgrammeItem[] = [
    { id: "done", title: "t", status: "COMPLETE", dependsOn: [], evidence: "e", unblocks: [] },
    { id: "open", title: "t", status: "BLOCKED_ON_OWNER", decision: "d", dependsOn: [], evidence: "e", unblocks: [] },
  ];
  const steps = [
    step({ order: 1, id: "A", preconditions: ["done"] }),
    step({ order: 2, id: "B", preconditions: ["open"] }),
    step({ order: 3, id: "C", preconditions: [] }),
  ];

  it("a step with no preconditions is ready, and one with an open input is not", () => {
    expect(readyNow(steps, items).map((s) => s.id)).toEqual(["A", "C"]);
  });

  it("stopsAt names the FIRST step that is not ready, not the last", () => {
    expect(stopsAt(steps, items)?.id).toBe("B");
  });

  it("and returns null when the whole plan is ready", () => {
    expect(stopsAt([step({ order: 1, id: "A" })], items)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("the real sequence", () => {
  it("is coherent against the real programme graph", () => {
    expect(validateSequence(ACTIVATION_SEQUENCE, PROGRAMME)).toEqual([]);
  });

  it("has nine steps and ends with the activation, not with promotion", () => {
    // Promotion is not activation. Conflating them is how a flag gets flipped because a gate
    // went green.
    expect(ACTIVATION_SEQUENCE).toHaveLength(9);
    expect(ACTIVATION_SEQUENCE[8]!.id).toBe("ENABLE-CANONICALIZATION");
    expect(ACTIVATION_SEQUENCE[8]!.what).toMatch(/THIS IS THE ACTIVATION/);
  });

  it("READS the flag before changing anything", () => {
    // Every severity assessment in the register is a function of a value nobody has read.
    expect(ACTIVATION_SEQUENCE[0]!.id).toBe("READ-FLAG");
    expect(ACTIVATION_SEQUENCE[0]!.authorisation).toBe("OWNER");
  });

  it("spends AFTER the corpus writes and AFTER the semantics ruling", () => {
    const evidence = ACTIVATION_SEQUENCE.find((s) => s.id === "FRESH-EVIDENCE")!;
    const seed = ACTIVATION_SEQUENCE.find((s) => s.id === "D7C-SEED")!;
    // Measure the corpus that will be promoted, not the one before it — and buy the fixture the
    // ruling selects, not the other one.
    expect(evidence.order).toBeGreaterThan(seed.order);
    expect(evidence.preconditions).toContain("NO-REGRESSION-SEMANTICS");
    expect(evidence.authorisation).toBe("AI_SPEND");
  });

  it("observes with canonicalization still OFF, between promotion and the flag", () => {
    const observe = ACTIVATION_SEQUENCE.find((s) => s.id === "OBSERVE")!;
    const promote = ACTIVATION_SEQUENCE.find((s) => s.id === "PROMOTE")!;
    const enable = ACTIVATION_SEQUENCE.find((s) => s.id === "ENABLE-CANONICALIZATION")!;
    expect(observe.order).toBeGreaterThan(promote.order);
    expect(observe.order).toBeLessThan(enable.order);
    expect(observe.authorisation).toBe("NONE");
  });

  it("every production write names a verification AND a rollback", () => {
    const writes = ACTIVATION_SEQUENCE.filter((s) => s.authorisation === "PRODUCTION_WRITE");
    expect(writes.map((s) => s.id)).toEqual(["ALIAS-CLEANUP", "D7C-SEED", "PROMOTE"]);
    for (const s of writes) {
      expect(s.rollback, s.id).not.toBeNull();
      expect(s.verification.length, s.id).toBeGreaterThan(30);
    }
  });

  it("the enable step is honest that rollback does not unwrite rows", () => {
    const enable = ACTIVATION_SEQUENCE.find((s) => s.id === "ENABLE-CANONICALIZATION")!;
    expect(enable.rollback).toMatch(/NOT rolled back/);
  });
});

describe("where the sequence stops today", () => {
  it("it stops at step 2 — every ruling is still outstanding", () => {
    const stop = stopsAt(ACTIVATION_SEQUENCE, PROGRAMME);
    // Step 1 has no preconditions, so it is 'ready' in the graph's terms — reading the flag
    // needs a person, not a decision.
    expect(stop?.id).toBe("ALIAS-CLEANUP");
    expect(stop?.order).toBe(3);
  });

  it("only the steps that decide or observe are ready; nothing that writes is", () => {
    const ready = readyNow(ACTIVATION_SEQUENCE, PROGRAMME).map((s) => s.id);
    expect(ready).toEqual(["READ-FLAG", "RULE-DECISIONS", "OBSERVE"]);
    for (const id of ready) {
      const s = ACTIVATION_SEQUENCE.find((x) => x.id === id)!;
      expect(s.authorisation, id).not.toBe("PRODUCTION_WRITE");
    }
  });
});

describe("this file cannot activate anything", () => {
  const src = readFileSync(join(__dirname, "activation-sequence.ts"), "utf8");

  it("holds no database handle and no client", () => {
    expect(src).not.toContain("createDbClient");
    expect(src).not.toContain("drizzle-orm");
    expect(src).not.toContain("process.env");
  });

  it("names runners as strings and invokes nothing", () => {
    expect(src).not.toContain("execFileSync");
    expect(src).not.toContain("child_process");
    expect(src).not.toMatch(/\bexec\(/);
  });

  it("and every runner it names is dry-run-by-default or explicitly authorised", () => {
    for (const s of ACTIVATION_SEQUENCE) {
      if (s.runner === null) continue;
      const writes = /--apply|--run\b/.test(s.runner);
      if (writes) {
        expect(s.runner, s.id).toMatch(/--i-am-authorised-to-write-to-production|--experiment/);
      }
    }
  });
});
