import { describe, it, expect } from "vitest";
import { statusTone } from "./status-pill";

/**
 * Status tone.
 *
 * The load-bearing property is the FALLBACK. A status this portal has not been taught
 * about is exactly the one an operator should look at — so an unknown value must read as
 * "warn", never as "ok". Defaulting to green would silently hide every new state the
 * backend adds, and it would hide it in the calmest possible colour.
 */

describe("statusTone", () => {
  it("only genuinely-fine states read as ok", () => {
    for (const s of ["active", "open", "verified", "confirmed", "applied"]) {
      expect(statusTone(s), s).toBe("ok");
    }
  });

  it("punitive and terminal states read as bad", () => {
    for (const s of ["suspended", "rejected"]) {
      expect(statusTone(s), s).toBe("bad");
    }
  });

  it("states needing attention read as warn", () => {
    for (const s of ["pending", "paused", "unverified", "extracting"]) {
      expect(statusTone(s), s).toBe("warn");
    }
  });

  it("inert states read as muted", () => {
    for (const s of ["draft", "closed", "skipped"]) {
      expect(statusTone(s), s).toBe("muted");
    }
  });

  it("an UNKNOWN status falls back to warn, never ok", () => {
    // The whole point. A future `status: 'under_review'` must not render green.
    for (const s of ["under_review", "frozen", "banned", "whatever"]) {
      expect(statusTone(s), s).toBe("warn");
      expect(statusTone(s), s).not.toBe("ok");
    }
  });

  it("is case-insensitive", () => {
    expect(statusTone("ACTIVE")).toBe("ok");
    expect(statusTone("Suspended")).toBe("bad");
  });

  it("null / undefined / empty read as muted, not ok", () => {
    expect(statusTone(null)).toBe("muted");
    expect(statusTone(undefined)).toBe("muted");
    expect(statusTone("")).toBe("muted");
  });
});
