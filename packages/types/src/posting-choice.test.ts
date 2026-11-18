/**
 * #2751 items 1 to 3 — the posting choice sets. `packages/db` spells them into the
 * `job_posting_choices` CHECKs (its migration test pins those copies to these) and
 * `job_posting.posting_choice_recorded` takes its v1 enums from them, so this file pins the sets.
 */
import { describe, expect, it } from "vitest";

import { POSTING_CHOICES, POSTING_SURFACES } from "./index";

describe("posting choice sets", () => {
  it("the two buttons, free first, frozen", () => {
    expect(POSTING_CHOICES).toEqual(["free", "free_plus_pack"]);
    expect(Object.isFrozen(POSTING_CHOICES)).toBe(true);
  });

  it("the two surfaces, frozen", () => {
    expect(POSTING_SURFACES).toEqual(["web", "app"]);
    expect(Object.isFrozen(POSTING_SURFACES)).toBe(true);
  });
});
