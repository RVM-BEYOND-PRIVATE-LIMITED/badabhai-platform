import { describe, it, expect } from "vitest";
import { WORKER_FEEDBACK_APP_BUILD_MAX } from "@badabhai/types";
import { APP_BUILD_HEADER, sanitizeAppBuild } from "./app-build";

describe("the x-app-build header (#966) — sanitized, never rejected", () => {
  it("names the header exactly as the shipped client sends it", () => {
    // The worker app sets `x-app-build` on EVERY request (api_client.dart). Nest lowercases
    // header lookups, so the constant must be lowercase or `@Headers()` silently reads nothing
    // and every submission records an unknown build.
    expect(APP_BUILD_HEADER).toBe("x-app-build");
  });

  it("keeps the three shapes a real build stamp actually takes", () => {
    expect(sanitizeAppBuild("dev")).toBe("dev");
    expect(sanitizeAppBuild("abc1234")).toBe("abc1234");
    expect(sanitizeAppBuild("1.4.2+318")).toBe("1.4.2+318");
  });

  it("trims surrounding whitespace rather than storing it", () => {
    // A proxy or a client-side string interpolation can leave a trailing newline; " abc1234 "
    // and "abc1234" are the same build and must not become two rows in the admin build column.
    // The LF is written as an ESCAPE, never as a literal byte — `source-hygiene.test.ts` scans
    // the whole repo for raw control characters in source.
    expect(sanitizeAppBuild("  abc1234\u000A")).toBe("abc1234");
  });

  it("returns null for an absent header instead of throwing", () => {
    // THE WHOLE POINT: a missing or garbage stamp must never cost a worker their typed feedback.
    expect(sanitizeAppBuild(undefined)).toBeNull();
    expect(sanitizeAppBuild(null)).toBeNull();
    expect(sanitizeAppBuild("")).toBeNull();
    expect(sanitizeAppBuild("   ")).toBeNull();
  });

  it("returns null for a non-string, including the array Node hands back for a repeat header", () => {
    // `@Headers("x")` types as `string | undefined`, but a duplicated header on the wire is a
    // `string[]` at the Node layer. Defensive, and the reason the parameter is `unknown`.
    expect(sanitizeAppBuild(["abc1234", "def5678"])).toBeNull();
    expect(sanitizeAppBuild(42)).toBeNull();
    expect(sanitizeAppBuild({ build: "abc1234" })).toBeNull();
  });

  it("bounds the value at WORKER_FEEDBACK_APP_BUILD_MAX, and the bound IS the shared constant", () => {
    // Derived from the constant, not from a re-typed 64: the DB CHECK and the event payload pin
    // the same number, and a literal here is how those copies drift apart.
    const atMax = "a".repeat(WORKER_FEEDBACK_APP_BUILD_MAX);
    expect(sanitizeAppBuild(atMax)).toBe(atMax);
    expect(sanitizeAppBuild(`${atMax}a`)).toBeNull();
  });

  it("refuses anything outside the build-id charset", () => {
    // Not an input-validation gate (nothing here 400s) — it is what keeps an untrusted header
    // from reaching the admin screen or an event payload carrying markup, spaces or a path.
    expect(sanitizeAppBuild("a b")).toBeNull();
    expect(sanitizeAppBuild("<script>")).toBeNull();
    expect(sanitizeAppBuild("../../etc/passwd")).toBeNull();
    expect(sanitizeAppBuild("abc 123")).toBeNull();
  });

  it("never throws, for any input at all", () => {
    // Stated as a property, because the ONE behaviour every caller depends on is that this
    // function can never be the reason a submission fails.
    const hostile: unknown[] = [
      undefined,
      null,
      Number.NaN,
      Symbol("x"),
      () => "abc",
      {
        toString: () => {
          throw new Error("a hostile object must not be coerced in the first place");
        },
      },
      ["abc1234"],
    ];
    for (const value of hostile) {
      expect(() => sanitizeAppBuild(value)).not.toThrow();
      expect(sanitizeAppBuild(value)).toBeNull();
    }
  });
});
