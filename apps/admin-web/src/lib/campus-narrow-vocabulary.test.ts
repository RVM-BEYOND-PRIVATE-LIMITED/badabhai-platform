import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTING_REASON_CODES } from "./company-vocabulary";
import {
  NARROWABLE_ROLE_KINDS,
  NARROWABLE_ROLE_LABELS,
  NARROW_DEFAULT_REASON,
  NARROW_REASON_CODES,
  narrowOutcomeCopy,
  narrowReasonValid,
} from "./campus-narrow-view";

/**
 * #3050 — the six machine trades the dialog offers are the API's closed set, byte for byte.
 * Re-typing the list here is how the two drift; this reads the authority.
 */
const here = dirname(fileURLToPath(import.meta.url));
const API_DTO = join(
  here,
  "..",
  "..",
  "..",
  "api",
  "src",
  "admin-postings",
  "admin-campus-narrow.dto.ts",
);

function apiKinds(): string[] {
  const src = readFileSync(API_DTO, "utf8");
  const block = src.slice(src.indexOf("NARROWABLE_ROLE_KINDS = ["));
  const list = block.slice(0, block.indexOf("] as const"));
  return [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("the narrow queue's vocabulary", () => {
  it("offers exactly the API's six machine trades, in its order", () => {
    expect([...NARROWABLE_ROLE_KINDS]).toEqual(apiKinds());
  });

  it("names them exactly as the issue names them", () => {
    expect(NARROWABLE_ROLE_LABELS).toEqual({
      cnc_turner: "CNC Turner",
      vmc_milling: "VMC / Milling Operator",
      cnc_grinding: "CNC Grinding Operator",
      sheet_metal_worker: "Sheet Metal Worker",
      press_operator: "Press Operator",
      injection_moulding_operator: "Injection Moulding Operator",
    });
  });

  it("uses only reason codes the posting edit already accepts", () => {
    for (const code of NARROW_REASON_CODES) {
      expect(POSTING_REASON_CODES).toContain(code);
    }
  });

  it("keeps the API's 15–500 character reason floor and ceiling", () => {
    expect(narrowReasonValid("x".repeat(14))).toBe(false);
    expect(narrowReasonValid("x".repeat(15))).toBe(true);
    expect(narrowReasonValid("x".repeat(500))).toBe(true);
    expect(narrowReasonValid("x".repeat(501))).toBe(false);
    expect(narrowReasonValid(NARROW_DEFAULT_REASON)).toBe(true);
  });

  it("has copy for every outcome the API can answer", () => {
    for (const outcome of [
      "changed",
      "not_found",
      "not_campus_origin",
      "not_narrowable",
      "posting_closed",
      "trade_not_released",
    ]) {
      expect(narrowOutcomeCopy(outcome)).toBeTruthy();
    }
    expect(narrowOutcomeCopy("a_new_outcome")).toBe("The job was not changed.");
  });
});
