import { describe, it, expect } from "vitest";
import { SetMyNameSchema } from "./workers.dto";

/**
 * `SetMyNameSchema` — the body of PATCH /workers/me/name.
 *
 * WHY THIS FILE EXISTS NOW. Until #1428 there was no test for this schema at all, and the defect
 * it shipped was invisible for exactly that reason: a non-strict `z.object` SILENTLY STRIPS
 * unknown keys, so a client could send `city`/`state`, get a 200, and store nothing. No error, no
 * log, no failing test — the field simply did not exist and nothing said so.
 */
describe("SetMyNameSchema", () => {
  const parse = (body: unknown) => SetMyNameSchema.safeParse(body);

  it("accepts a name-only body unchanged — the pre-#1428 request shape", () => {
    const res = parse({ full_name: "Asha Kumari" });
    expect(res.success).toBe(true);
    expect(res.success && res.data).toEqual({ full_name: "Asha Kumari" });
  });

  it("now KEEPS city and state instead of silently dropping them (#1428)", () => {
    // The exact body the onboarding screen sends. Before this change the two location keys were
    // stripped here and the worker's answer was lost between the handset and the database.
    const res = parse({ full_name: "Asha Kumari", city: "Pune", state: "Maharashtra" });
    expect(res.success).toBe(true);
    expect(res.success && res.data).toEqual({
      full_name: "Asha Kumari",
      city: "Pune",
      state: "Maharashtra",
    });
  });

  it("accepts either half alone — a manual entry can supply one without the other", () => {
    expect(parse({ full_name: "A", city: "Pune" }).success).toBe(true);
    expect(parse({ full_name: "A", state: "Bihar" }).success).toBe(true);
  });

  it("trims, and applies the same guards full_name has", () => {
    const res = parse({ full_name: "Asha", city: "  Pune  ", state: "  Bihar " });
    expect(res.success && res.data.city).toBe("Pune");
    expect(res.success && res.data.state).toBe("Bihar");

    // Control characters: the same class of injection the name has always rejected.
    expect(parse({ full_name: "Asha", city: "Pu\u0000ne" }).success).toBe(false);
    // Digits-only is a fat-fingered pincode or phone, not a place name.
    expect(parse({ full_name: "Asha", city: "411001" }).success).toBe(false);
    // Bounded, so a body cannot carry an essay in a column sized for a city.
    expect(parse({ full_name: "Asha", city: "x".repeat(81) }).success).toBe(false);
    expect(parse({ full_name: "Asha", city: "x".repeat(80) }).success).toBe(true);
    // Whitespace-only collapses to empty and is refused rather than stored as "".
    expect(parse({ full_name: "Asha", city: "   " }).success).toBe(false);
  });

  it("does NOT reject a city outside the matching gazetteer", () => {
    // Deliberate, and the opposite of `preferred_cities` (#1406), which 400s on an unresolved
    // city. This is screen one of onboarding: refusing a real place the closed manufacturing-hub
    // set happens not to list would dead-end the worker at the first question.
    expect(parse({ full_name: "Asha", city: "Muzaffarpur", state: "Bihar" }).success).toBe(true);
  });

  it("still requires full_name — the location is additive, not a replacement", () => {
    expect(parse({ city: "Pune" }).success).toBe(false);
    expect(parse({ full_name: "" }).success).toBe(false);
  });

  it("still strips genuinely unknown keys rather than 400ing on them", () => {
    // NOT made `.strict()`, on purpose. Turning a silently-ignored field into a 400 would break
    // any already-released build that sends one (§3, backward compatibility).
    const res = parse({ full_name: "Asha", pincode: "411001" });
    expect(res.success).toBe(true);
    expect(res.success && res.data).toEqual({ full_name: "Asha" });
  });
});
