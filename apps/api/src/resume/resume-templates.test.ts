import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  RESUME_TEMPLATES,
  FALLBACK_TEMPLATE_ID,
  getResumeTemplate,
} from "./templates/registry";

const DIR = join(__dirname, "templates");

describe("resume template registry", () => {
  it("has unique template ids", () => {
    const ids = RESUME_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has exactly one fallback, matching FALLBACK_TEMPLATE_ID", () => {
    const fallbacks = RESUME_TEMPLATES.filter((t) => t.fallback);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.id).toBe(FALLBACK_TEMPLATE_ID);
  });

  it("every registered template file exists and is non-empty HTML", () => {
    for (const t of RESUME_TEMPLATES) {
      const path = join(DIR, t.file);
      expect(existsSync(path), `${t.file} is registered but missing on disk`).toBe(true);
      const html = readFileSync(path, "utf8");
      expect(html.length, `${t.file} is empty`).toBeGreaterThan(0);
      expect(html.toLowerCase()).toContain("<!doctype html>");
    }
  });

  it("resolves known ids and falls back for unknown/empty ids", () => {
    expect(getResumeTemplate("modern").id).toBe("modern");
    expect(getResumeTemplate("classic").id).toBe("classic");
    expect(getResumeTemplate("does-not-exist").id).toBe(FALLBACK_TEMPLATE_ID);
    expect(getResumeTemplate(null).id).toBe(FALLBACK_TEMPLATE_ID);
    expect(getResumeTemplate(undefined).id).toBe(FALLBACK_TEMPLATE_ID);
  });
});
