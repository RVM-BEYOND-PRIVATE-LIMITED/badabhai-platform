import { describe, it, expect } from "vitest";
import { isDevEnv } from "./shared";
import { loadServerConfig } from "./server";

/**
 * R14 regression guard: the boot gates must FAIL CLOSED on an unset/unknown
 * NODE_ENV. `isDevEnv` is the single source of truth for "dev shortcuts allowed";
 * if anyone loosens it (e.g. treats unset as dev, or starts reading the Zod-parsed
 * config), these tests break — which is the point.
 */
describe("isDevEnv (canonical fail-closed dev gate)", () => {
  it("is true ONLY for explicit development/test", () => {
    expect(isDevEnv("development")).toBe(true);
    expect(isDevEnv("test")).toBe(true);
  });

  it("is false for every non-dev value and typo", () => {
    // NB: passing `undefined` would trigger the default param (reads
    // process.env.NODE_ENV), so the unset case is covered by the raw-env test below.
    for (const v of ["", "staging", "production", "dev", "prod", "Development", "TEST"]) {
      expect(isDevEnv(v)).toBe(false);
    }
  });

  it("reads raw process.env.NODE_ENV when called with no argument", () => {
    const prev = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      expect(isDevEnv()).toBe(false); // unset => fail closed
      process.env.NODE_ENV = "production";
      expect(isDevEnv()).toBe(false);
      process.env.NODE_ENV = "development";
      expect(isDevEnv()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("the parsed config is fail-OPEN but isDevEnv stays fail-CLOSED on unset (the footgun)", () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      // The Zod-parsed value silently defaults to "development" when unset...
      expect(
        loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }).NODE_ENV,
      ).toBe("development");
      // ...so a security gate MUST NOT key off it. The raw-env helper does not
      // treat an unset env as dev — never conflate the two.
      expect(isDevEnv(process.env.NODE_ENV)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
