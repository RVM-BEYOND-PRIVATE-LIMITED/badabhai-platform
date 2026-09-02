import { describe, expect, it } from "vitest";

import { routeToTradeForm, type TradeFormKind } from "./trade-form-router";

/**
 * THE ROUTING TABLE, ASSERTED CASE BY CASE.
 *
 * The regression that matters is NOT "does a turner reach the form" — it is "does anyone else".
 * Every wrong route ends a worker's interview and hands them eighteen questions about a machine
 * they have never touched, so the negative cases outnumber the positive ones deliberately.
 */
function route(
  domain: string | null,
  role: string | null,
  familyId: string | null = null,
  occupationLabel: string | null = null,
  workerText: string | null = null,
): TradeFormKind | null {
  return routeToTradeForm({
    draft: { domain_label: domain, role_label: role, skills: [], experiences: [] },
    occupationFamilyId: familyId,
    occupationLabel,
    workerText,
  });
}

describe("routeToTradeForm", () => {
  describe("routes a turner", () => {
    const turners: readonly (readonly [string, string | null, string | null])[] = [
      ["CNC Machining", "CNC Turner", null],
      ["CNC Machining", "CNC Turner/Operator", null],
      ["Manufacturing", "Turner", null],
      ["CNC Turning", "Operator", null],
      ["Machining", "turning operator", null],
      ["सीएनसी", "टर्नर", null],
      // Machine-only evidence, corroborated by the pin retrieval made independently.
      ["Manufacturing", "lathe operator", "fam_cnc_turning"],
      ["Manufacturing", "khraad chalata hoon", "fam_cnc_turning"],
      ["विनिर्माण", "खराद ऑपरेटर", "fam_cnc_turning"],
    ];
    for (const [domain, role, family] of turners) {
      it(`${JSON.stringify({ domain, role, family })}`, () => {
        expect(route(domain, role, family)).toBe("cnc_turner");
      });
    }
  });

  describe("does not route a machine name on its own", () => {
    // The `signals.py` rule: a lathe is equipment, not an occupation. Without the corroborating
    // pin these fall through to the interview, which is what already handles an unclear trade.
    const uncorroborated: readonly (readonly [string, string])[] = [
      ["Manufacturing", "lathe operator"],
      ["Manufacturing", "khraad par kaam"],
      ["Engineering", "CNC operator"],
      ["Manufacturing", "machine operator"],
    ];
    for (const [domain, role] of uncorroborated) {
      it(`${role} with no pin`, () => {
        expect(route(domain, role, null)).toBeNull();
      });
    }

    it("a lathe term pinned to some OTHER family is still not a turner", () => {
      expect(route("Manufacturing", "lathe operator", "fam_machining")).toBeNull();
    });
  });

  describe("a competing specialisation vetoes the route", () => {
    const conflicted: readonly (readonly [string, string])[] = [
      // A rung with no occupation word. "Setter-cum-Operator" is shared vocabulary across every
      // machining role, so it corroborates a pin and never carries a route by itself.
      ["CNC Machining", "VMC Setter-cum-Operator"],
      // A role we DECLARE but do not serve. The veto is what keeps such a worker talking to the
      // interview rather than being handed the nearest enabled form, and it is why a disabled
      // descriptor is load-bearing rather than a placeholder. Grinding used to sit here too, and
      // moved to its own block below when Batch 1 authored its pack.
      ["Manufacturing", "drilling operator"],
      // Ambiguous by the worker's own account: keep talking rather than guess which form fits.
      // BOTH roles are enabled now, and this must STILL reach neither — an enabled rival is a
      // stronger test of the veto than a declared-only one, because there is now a second form
      // it could wrongly land in.
      ["CNC Machining", "CNC Turner cum VMC Operator"],
      ["CNC Machining", "turner and milling operator"],
    ];
    for (const [domain, role] of conflicted) {
      it(`${role}`, () => {
        expect(route(domain, role, null)).toBeNull();
      });
    }

    it("vetoes even when the turning family is pinned", () => {
      expect(route("CNC Machining", "CNC Turner cum VMC Operator", "fam_cnc_turning")).toBeNull();
    });
  });

  describe("the machining-centre form, enabled in Batch 1", () => {
    // THESE TWO USED TO ASSERT `null`, AND THE CHANGE IS THE FEATURE RATHER THAN A RELAXED TEST.
    // They sat under "a competing specialisation vetoes the route" for one reason: turning was the
    // only form that existed, so the only correct thing to do with a miller was to keep them
    // talking. The assertion that mattered was never "reaches nothing" — it was "must not be
    // handed the TURNER form", which is why each case below pins the kind rather than merely
    // asserting non-null.
    const milling: readonly (readonly [string, string])[] = [
      ["CNC Machining", "VMC Operator"],
      ["Manufacturing", "milling machine operator"],
      ["CNC Machining", "HMC Operator"],
      ["Manufacturing", "मिलिंग"],
    ];
    for (const [domain, role] of milling) {
      it(`${role} reaches the machining-centre form and not the turner's`, () => {
        expect(route(domain, role, null)).toBe("vmc_milling");
      });
    }

    it("still needs a family pin for a bare machine word", () => {
      // `vmc` is a MACHINE term, not an occupation: a worker who names the machine has told us
      // what they stand at, not which of the occupations built around it is theirs. This is the
      // `signals.py` rule that this router exists to hold, and enabling a second role is exactly
      // when it would quietly stop holding.
      expect(route("Manufacturing", "vmc", null)).toBeNull();
      expect(route("Manufacturing", "vmc", "fam_vmc_milling")).toBe("vmc_milling");
    });

    it("does not let the machining-centre form claim a grinder", () => {
      // THE THIRD MACHINING ROLE MAKES THIS SHARPER, not merely longer. Turner and miller vetoed
      // "grinding" from the day grinding was DECLARED — the whole argument for declaring a role
      // before building it. Now that grinding is enabled, the same word must ROUTE rather than
      // only veto, and it must route to grinding and to neither of the other two.
      expect(route("Manufacturing", "grinding operator", null)).toBe("cnc_grinding");
      expect(route("Manufacturing", "surface grinder", "fam_cnc_grinding")).toBe("cnc_grinding");
      expect(route("Manufacturing", "ghisai ka kaam", "fam_cnc_grinding")).toBe("cnc_grinding");
      // And a worker who claims two of the three still reaches none of them.
      expect(route("CNC Machining", "grinding aur turning dono", null)).toBeNull();
      expect(route("CNC Machining", "milling aur grinding", null)).toBeNull();
    });

    it("does not let the turner form claim a miller, in either direction", () => {
      // The symmetry is the point. Turner vetoes milling's vocabulary and milling vetoes
      // turning's, both DERIVED from the shared `machining` cluster rather than hand-listed — so
      // neither can be widened without the other following.
      expect(route("CNC Machining", "VMC Operator", "fam_cnc_turning")).not.toBe("cnc_turner");
      expect(route("Manufacturing", "CNC turner", "fam_vmc_milling")).not.toBe("vmc_milling");
    });
  });

  describe("routes nobody else", () => {
    const others: readonly (readonly [string | null, string | null])[] = [
      ["Retail", "Cashier"],
      ["Transport", "Bus driver"],
      ["Construction", "Electrician"],
      ["Garments", "Tailor"],
      ["Hospitality", "Cook"],
      ["Welding", "MIG welder"],
      [null, null],
      ["", ""],
      [null, "   "],
    ];
    for (const [domain, role] of others) {
      it(`${JSON.stringify({ domain, role })}`, () => {
        expect(route(domain, role, null)).toBeNull();
      });
    }

    it("a pinned turning family alone does not route a label that never mentions turning", () => {
      // The pin corroborates a machine term; it is not evidence by itself. A mis-pin must not be
      // able to end an interview on its own.
      expect(route("Retail", "Cashier", "fam_cnc_turning")).toBeNull();
    });
  });

  /**
   * ═══ THE PINNED LABEL, WHICH IS WHY THE HANDOVER IS NOT A TURN LATE ═══
   *
   * Observed in production: a worker answered "cnc turning", and the interview asked which
   * materials they cut before handing over on the NEXT turn. The model had not filled
   * `domain_label`/`role_label` yet, so the router had nothing to read — while retrieval had
   * already pinned the occupation from that same sentence.
   *
   * The pin is the only evidence here that is not the model's. It joins the same haystack and is
   * read by the same two rules, so it widens WHEN the router can decide without widening WHAT it
   * will decide.
   */
  describe("the pinned catalogue label is evidence too", () => {
    // Every label actually bound to `fam_cnc_turning` in `_families.jsonl` (NCO 7223).
    const bound: readonly (readonly [string, string | null])[] = [
      ["Turner/Conventional Turning", null],
      ["CNC Setter cum Operator-Turning", null],
      ["CNC Operator-Turning", null],
      // "Lathe Machinist" is a MACHINE name, so it routes only with the family corroborating —
      // the same rule that governs a model-supplied "lathe operator", applied to the pin.
      ["Lathe Machinist", "fam_cnc_turning"],
    ];
    for (const [label, family] of bound) {
      it(`routes on a bare pin of ${JSON.stringify(label)}`, () => {
        // The model has said NOTHING — both draft labels null, exactly the turn-one state that
        // cost the worker the extra question.
        expect(route(null, null, family, label)).toBe("cnc_turner");
      });
    }

    it("routes a turner on turn one, with the model still silent", () => {
      expect(route(null, null, null, "CNC Operator-Turning")).toBe("cnc_turner");
    });

    it('rescues the real "machining" session, where the model spoke but said nothing useful', () => {
      // A RECORDED SESSION IN THIS REPO ran six turns with domain_label "machining" and a null
      // role. "machining" is in neither the occupation nor the machine list, and bare "machining"
      // is deliberately NOT a conflict term either (only "machining centre"/"center" are) — so it
      // is a non-empty haystack that routes nowhere, indistinguishable from silence.
      //
      // Worth its own case because it fails DIFFERENTLY from the null-label turn: the empty-
      // haystack guard never fires, so a fix that only handled "the model said nothing" would
      // have left this worker interviewing to the end.
      expect(route("machining", null, null)).toBeNull();
      expect(route("machining", null, "fam_cnc_turning", "CNC Operator-Turning")).toBe(
        "cnc_turner",
      );
    });

    it("a mis-pinned worker is STILL not routed — the label has to say so", () => {
      // The property the family-alone rule was written to protect, now restated against the
      // label. A cashier wrongly pinned into the turning family contributes "Cashier", which
      // matches nothing, so the mis-pin cannot end their interview on its own.
      expect(route("Retail", "Cashier", "fam_cnc_turning", "Cashier")).toBeNull();
    });

    it("conflict terms veto the pin exactly as they veto the model", () => {
      // A pin is not a trump card. If the evidence taken together names a competing
      // specialisation, nobody routes.
      expect(route(null, "VMC operator", "fam_cnc_turning", "CNC Operator-Turning")).toBeNull();
    });

    it("an empty pin changes nothing", () => {
      expect(route("Retail", "Cashier", null, null)).toBeNull();
      expect(route("CNC Machining", "CNC Turner", null, null)).toBe("cnc_turner");
    });
  });

  /**
   * ═══ THE WORKER'S OWN WORDS, FOR THE VETO ONLY ═══
   *
   * Raw worker text may make this router more reluctant and never more willing. That asymmetry is
   * what makes reading free text safe here at all: matching occupation or machine terms against it
   * would be the machine-plus-function fabrication the module refuses to do at the top.
   */
  describe("a conflict the worker states out loud", () => {
    it('does not hand over "cnc turning aur vmc dono karta hoon"', () => {
      // THE CASE THE PINNED LABEL OPENED UP. Retrieval pins the longest exact alias span, so this
      // pins cleanly on "cnc turning"; bare "vmc" is not an alias, contributes no rival candidate,
      // and the pin returns auto at high confidence. The label is then "CNC Operator-Turning" and
      // the model's draft is still empty — so every surface the veto could read says "turner",
      // and the worker's own "vmc" lives only in the sentence they typed.
      expect(
        route(
          null,
          null,
          "fam_cnc_turning",
          "CNC Operator-Turning",
          "cnc turning aur vmc dono karta hoon",
        ),
      ).toBeNull();
    });

    it("still hands over a worker who mentions no competing machine", () => {
      // The discriminating case: without it the assertion above would pass against a router that
      // had stopped handing over at all once it started reading worker text.
      expect(
        route(null, null, "fam_cnc_turning", "CNC Operator-Turning", "main cnc turning karta hoon"),
      ).toBe("cnc_turner");
    });

    it("worker text can never CAUSE a handover, only prevent one", () => {
      // The asymmetry, asserted directly. A worker whose sentence is full of turning words but
      // whom nothing has pinned and whom the model has not labelled routes nowhere — otherwise
      // "cnc turning ka kaam dhoondh raha hoon" (LOOKING for turning work) would hand a job
      // seeker eighteen questions about a machine they may never have touched.
      expect(route(null, null, null, null, "cnc turner turning lathe khraad")).toBeNull();
    });

    it("vetoes on the worker's words even when the model wrote a clean label", () => {
      expect(
        route("CNC Machining", "CNC Turner", null, null, "turning aur milling dono karta hoon"),
      ).toBeNull();
    });
  });

  describe("substring safety", () => {
    it("does not match a term inside a longer word", () => {
      // "returner" contains "turner"; token-boundary matching is what keeps it out.
      expect(route("Retail", "goods returner")).toBeNull();
    });

    it("matches across punctuation the model may emit", () => {
      expect(route("CNC-Machining", "CNC Turner / Operator")).toBe("cnc_turner");
    });
  });

  it("is pure — the same input routes the same way every time", () => {
    const once = route("CNC Machining", "CNC Turner");
    const twice = route("CNC Machining", "CNC Turner");
    expect(once).toBe(twice);
  });
});
