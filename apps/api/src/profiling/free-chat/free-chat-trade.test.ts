/**
 * #2355 — "does this message name a trade" against a real snapshot.
 *
 * The snapshot is small but REAL (`buildOccupationSnapshot`, real `matchSpan`): the
 * assertions below pin the routing-relevant behaviour, not the catalogue's size. The
 * full-catalogue parity (no bare intent spans a real alias) is owned by the
 * occupation-retrieval parity suite, not duplicated here.
 */
import { describe, expect, it } from "vitest";
import type { ResolvableBinding } from "@badabhai/db";

import { buildOccupationSnapshot } from "../../occupation/occupation-index";

import { namesATradeIn } from "./free-chat-trade";

const BINDINGS: ResolvableBinding[] = [
  { familyId: "fam_welding", iscoUnitCode: "7212" },
  { familyId: "fam_carpentry", iscoUnitCode: "7115" },
  { familyId: "fam_universal", isUniversal: true },
];

const snapshot = buildOccupationSnapshot({
  catalogVersion: "v-test-2355",
  domains: [
    { jobDomainId: "jd_weld", labelEn: "Welder, Gas", labelHi: null, iscoUnitCode: "7212" },
    {
      jobDomainId: "jd_carp",
      labelEn: "Carpenters and Joiners",
      labelHi: null,
      iscoUnitCode: "7115",
    },
  ],
  aliases: [
    { jobDomainId: "jd_weld", text: "welder" },
    { jobDomainId: "jd_weld", text: "welding" },
    { jobDomainId: "jd_carp", text: "Carpenter" },
    { jobDomainId: "jd_carp", text: "shuttering carpenter" },
    { jobDomainId: "jd_carp", text: "carpenter mistri" },
  ],
  bindings: BINDINGS,
});

const namesATrade = namesATradeIn(() => snapshot.spans);

describe("namesATrade", () => {
  it("fires through the aspiration blocker: the trade is named, whatever else is said", () => {
    expect(namesATrade("mai carpenter mai profile banana chahta hu")).toBe(true);
  });

  it.each([["carpenter"], ["welder ki job chahiye"]])("fires on %j", (text) => {
    expect(namesATrade(text)).toBe(true);
  });

  it.each([["resume banana hai"], ["mai resume banana chahta hu"], ["profile banao"]])(
    "stays silent on the bare intent %j, so the opener is unchanged",
    (text) => {
      expect(namesATrade(text)).toBe(false);
    },
  );

  it("stays silent on the start chip", () => {
    expect(namesATrade("Haan, shuru karein")).toBe(false);
  });

  it("a null snapshot is always 'no' — the opener, never a guess", () => {
    const unwired = namesATradeIn(() => null);
    expect(unwired("mai carpenter mai profile banana chahta hu")).toBe(false);
    expect(unwired("carpenter")).toBe(false);
  });
});
