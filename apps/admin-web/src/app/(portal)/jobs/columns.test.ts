import { describe, expect, it } from "vitest";
import { audienceLabel } from "./columns";

/** #2746 — the admin list/detail read the audience token and show words, read-only. */
describe("audienceLabel", () => {
  it("maps the three closed audiences", () => {
    expect(audienceLabel("badabhai_workers")).toBe("BadaBhai workers");
    expect(audienceLabel("rvm_students")).toBe("RVM students");
    expect(audienceLabel("both")).toBe("Both");
  });

  it("an omitted block (the API's default) reads as an absent value", () => {
    expect(audienceLabel(undefined)).toBe("—");
  });
});
