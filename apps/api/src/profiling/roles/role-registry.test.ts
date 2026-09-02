/**
 * THE ROLE REGISTRY, AND THE PROPERTIES THAT MAKE DERIVING FROM IT SAFE.
 *
 * The eleven hand-maintained tables this registry replaces were each individually correct and
 * collectively unverifiable — nothing anywhere asserted that the routing table, the pack→kind map
 * and the fresher vocabulary were talking about the same trade. Deriving them fixes that by
 * construction, but only if the derivation itself is pinned. So the tests here are about the
 * DERIVATION, not about any one role:
 *
 *   - the shipped turner behaviour is byte-for-byte unchanged (the refactor's whole licence)
 *   - a role can never veto itself, at any registry size
 *   - level rungs are shared vocabulary and must never become vetoes
 *   - no two enabled roles can claim one worker, which is what makes registry ORDER irrelevant
 *
 * The last one matters more than it looks. `routeToTradeForm` returns the first matching route, so
 * an overlap between two enabled roles would resolve by import order — a coin toss that would pick
 * a different trade the day somebody sorted the imports.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertRegistryIsCoherent,
  conflictTermsFor,
  type RoleFormDescriptor,
} from "./role-form-descriptor";
import {
  conflictTermsForKind,
  descriptorForKind,
  descriptorForPack,
  ENABLED_ROLE_DESCRIPTORS,
  TRADE_FORM_KINDS,
} from "./role-registry";
import { TRADE_FORM_OFFERS } from "../trade-form-router";

/** The conflict terms `trade-form-router.ts` shipped as a hand-written literal, before deriving. */
const SHIPPED_TURNER_CONFLICTS = [
  "vmc",
  "hmc",
  "milling",
  "miller",
  "mill",
  "machining centre",
  "machining center",
  "grinding",
  "grinder",
  "drilling",
  "edm",
  "wire cut",
  "मिलिंग",
] as const;

function packExists(packId: string): boolean {
  try {
    readFileSync(
      join(__dirname, `../../../../../packages/db/data/question-packs/packs/${packId}.json`),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** A minimal descriptor, so the invariant tests can build cases the real registry cannot. */
function fake(over: Partial<RoleFormDescriptor> & { kind: string }): RoleFormDescriptor {
  return {
    packId: `qp_${over.kind}`,
    familyId: `fam_${over.kind}`,
    cluster: "machining",
    formEnabled: true,
    displayName: over.kind,
    offerName: over.kind,
    levelLadder: [],
    tenureQuestionKey: "x_experience",
    detection: { occupationTerms: [over.kind], machineTerms: [], levelTerms: [] },
    ...over,
  };
}

describe("the role registry", () => {
  describe("the shipped turner behaviour is unchanged", () => {
    it("derives every conflict term the hand-written table listed", () => {
      const derived = conflictTermsForKind("cnc_turner");
      expect(SHIPPED_TURNER_CONFLICTS.filter((term) => !derived.includes(term))).toEqual([]);
    });

    it("enables exactly the one form that ships", () => {
      expect([...TRADE_FORM_KINDS]).toEqual(["cnc_turner"]);
    });

    it("composes the handover copy byte-for-byte, including its sentence casing", () => {
      // Pinned against the Flutter contract fixture in `chat_form_offer_test.dart`, which asserts
      // these exact strings. Composing them from `displayName` would silently title-case the
      // headline and break a client test from the other side of the wire.
      expect(TRADE_FORM_OFFERS.cnc_turner).toEqual({
        kind: "cnc_turner",
        reply: "CNC turner profile detected. Ab form bharkar resume pura karein.",
        headline: "CNC turner profile detected",
        ctaLabel: "Form bharkar resume pura karein",
      });
    });
  });

  describe("what every enabled role must satisfy", () => {
    it("has a question pack that actually ships in the corpus", () => {
      // A DISABLED role deliberately may NOT — that is what "declared before it is built" means.
      // An ENABLED one without a pack is the 503 that told a worker they had no form.
      const missing = ENABLED_ROLE_DESCRIPTORS.filter((d) => !packExists(d.packId)).map(
        (d) => d.kind,
      );
      expect(missing).toEqual([]);
    });

    it("never shares an occupation term with another enabled role", () => {
      // The property that makes registry order irrelevant. Two enabled roles claiming one word
      // would resolve by import position rather than by evidence.
      const seen = new Map<string, string>();
      const clashes: string[] = [];
      for (const descriptor of ENABLED_ROLE_DESCRIPTORS) {
        for (const term of descriptor.detection.occupationTerms) {
          const owner = seen.get(term);
          if (owner !== undefined) clashes.push(`${term}: ${owner} and ${descriptor.kind}`);
          seen.set(term, descriptor.kind);
        }
      }
      expect(clashes).toEqual([]);
    });

    it("is never vetoed by one of its own terms", () => {
      const selfVetoed = ENABLED_ROLE_DESCRIPTORS.flatMap((descriptor) => {
        const own = [
          ...descriptor.detection.occupationTerms,
          ...descriptor.detection.machineTerms,
          ...descriptor.detection.levelTerms,
        ];
        return conflictTermsForKind(descriptor.kind)
          .filter((term) => own.includes(term))
          .map((term) => `${descriptor.kind} vetoes its own "${term}"`);
      });
      expect(selfVetoed).toEqual([]);
    });
  });

  describe("conflict derivation", () => {
    it("never promotes a level rung to a veto", () => {
      // "Setter" is a rung of four machining roles at once. Deriving it as a conflict would make
      // "CNC turning setter" — the exact phrase the owner's level-ladder ruling is about — veto
      // itself and never reach a form.
      //
      // SYNTHETIC ROLES WITH *DIFFERENT* RUNGS, and that is the whole point of this fixture. The
      // real machining roles all spell their ladder identically ("setter", "programmer"…), so
      // self-exclusion removes those words before the caller ever sees them and the defect this
      // test exists to catch is invisible against the shipped registry — mutation-verified: adding
      // `levelTerms` to the derivation left a registry-wide version of this test green. Rivals
      // whose rungs differ are what make the assertion able to fail.
      const a = fake({
        kind: "alpha",
        detection: { occupationTerms: ["alpha"], machineTerms: [], levelTerms: ["senior alpha"] },
      });
      const b = fake({
        kind: "beta",
        detection: { occupationTerms: ["beta"], machineTerms: [], levelTerms: ["junior beta"] },
      });
      expect(conflictTermsFor(a, [a, b])).toEqual(["beta"]);
      expect(conflictTermsFor(b, [a, b])).toEqual(["alpha"]);
    });

    it("still lets a word that is someone's OCCUPATION veto, even where it is also a rung", () => {
      // The rule is "a rung does not EARN a veto", not "a rung is immune from one". Press
      // Operator's ladder ends at "Setter" while it is a mid-rung elsewhere; if some role names
      // it as its occupation, that use is real evidence and must still veto its rivals.
      const a = fake({
        kind: "alpha",
        detection: { occupationTerms: ["alpha"], machineTerms: [], levelTerms: ["setter"] },
      });
      const b = fake({
        kind: "beta",
        detection: { occupationTerms: ["beta", "setter"], machineTerms: [], levelTerms: [] },
      });
      expect(conflictTermsFor(a, [a, b])).toEqual(["beta", "setter"]);
    });

    it("is symmetric inside a cluster", () => {
      // If A vetoes B's word, B must veto A's. An asymmetry means one of the two hands over on
      // evidence the other treats as disqualifying, which is the ambiguity reaching a worker.
      const a = fake({
        kind: "alpha",
        detection: { occupationTerms: ["alpha"], machineTerms: [], levelTerms: [] },
      });
      const b = fake({
        kind: "beta",
        detection: { occupationTerms: ["beta"], machineTerms: [], levelTerms: [] },
      });
      expect(conflictTermsFor(a, [a, b])).toEqual(["beta"]);
      expect(conflictTermsFor(b, [a, b])).toEqual(["alpha"]);
    });

    it("does not derive across clusters — only declared extras cross that line", () => {
      const machining = fake({ kind: "alpha", cluster: "machining" });
      const polymer = fake({ kind: "beta", cluster: "polymer" });
      expect(conflictTermsFor(machining, [machining, polymer])).toEqual([]);

      const withExtra = fake({
        kind: "alpha",
        cluster: "machining",
        detection: {
          occupationTerms: ["alpha"],
          machineTerms: [],
          levelTerms: [],
          extraConflictTerms: ["beta"],
        },
      });
      expect(conflictTermsFor(withExtra, [withExtra, polymer])).toEqual(["beta"]);
    });

    it("excludes a shared word by VALUE, so two roles naming one machine do not veto themselves", () => {
      // "Lathe" belongs to CNC Turner and to Conventional Machinist alike. Self-exclusion has to
      // drop every term of MY OWN rather than every term of the other role, or each of them vetoes
      // itself on the word they share and neither ever hands over.
      const turner = fake({
        kind: "alpha",
        detection: { occupationTerms: ["alpha"], machineTerms: ["lathe"], levelTerms: [] },
      });
      const machinist = fake({
        kind: "beta",
        detection: { occupationTerms: ["beta"], machineTerms: ["lathe"], levelTerms: [] },
      });
      expect(conflictTermsFor(turner, [turner, machinist])).toEqual(["beta"]);
      expect(conflictTermsFor(machinist, [turner, machinist])).toEqual(["alpha"]);
    });
  });

  describe("coherence is asserted at load, not discovered in production", () => {
    it("refuses two roles claiming one pack", () => {
      const a = fake({ kind: "alpha", packId: "qp_same" });
      const b = fake({ kind: "beta", packId: "qp_same" });
      expect(() => assertRegistryIsCoherent([a, b])).toThrow(/packId qp_same/);
    });

    it("refuses two roles claiming one family", () => {
      const a = fake({ kind: "alpha", familyId: "fam_same" });
      const b = fake({ kind: "beta", familyId: "fam_same" });
      expect(() => assertRegistryIsCoherent([a, b])).toThrow(/familyId fam_same/);
    });

    it("refuses a role that lists its own term as a conflict", () => {
      const self = fake({
        kind: "alpha",
        detection: {
          occupationTerms: ["alpha"],
          machineTerms: [],
          levelTerms: [],
          extraConflictTerms: ["alpha"],
        },
      });
      expect(() => assertRegistryIsCoherent([self])).toThrow(/lists its own term/);
    });

    it("refuses an enabled role that names no occupation term", () => {
      const mute = fake({
        kind: "alpha",
        detection: { occupationTerms: [], machineTerms: ["thing"], levelTerms: [] },
      });
      expect(() => assertRegistryIsCoherent([mute])).toThrow(/names no occupation terms/);
    });

    it("allows a DISABLED role to be incomplete — that is what declaring one early is for", () => {
      const declared = fake({
        kind: "alpha",
        formEnabled: false,
        detection: { occupationTerms: [], machineTerms: ["thing"], levelTerms: [] },
      });
      expect(() => assertRegistryIsCoherent([declared])).not.toThrow();
    });
  });

  describe("lookups", () => {
    it("finds a declared role by kind and by pack, enabled or not", () => {
      expect(descriptorForKind("cnc_turner")?.packId).toBe("qp_cnc_turning");
      expect(descriptorForPack("qp_vmc_milling")?.kind).toBe("vmc_milling");
      expect(descriptorForKind("not_a_role")).toBeUndefined();
      expect(descriptorForPack(null)).toBeUndefined();
    });
  });
});
