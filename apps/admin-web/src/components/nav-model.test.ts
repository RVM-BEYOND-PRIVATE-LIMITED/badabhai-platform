import { describe, it, expect } from "vitest";
import { NAV } from "./nav-model";

/**
 * The sidebar's names (owner rulings 2026-10-01). LABELS ONLY: every route, API path and
 * capability key stays exactly as it was — the ruling renames what an operator reads, never
 * what a bookmark, an audit link or a guard points at.
 */
const items = NAV.flatMap((s) => s.items);
const byHref = (href: string) => items.find((i) => i.href === href);

describe("nav labels", () => {
  it('the job entity is "Postings", on the unchanged /jobs route', () => {
    expect(byHref("/jobs")?.label).toBe("Postings");
    expect(items.some((i) => i.label === "Jobs")).toBe(false);
  });

  it('payment orders are named for what they are, on the unchanged /transactions route', () => {
    expect(byHref("/transactions")?.label).toBe("Payment orders");
    expect(items.some((i) => i.label === "Transactions")).toBe(false);
  });

  it("every label is sentence case and spelled out — no ampersand, no Title Case", () => {
    expect(byHref("/skills/discovery")?.label).toBe("Skill discovery");
    expect(byHref("/roles")?.label).toBe("Roles and capabilities");
    for (const item of items) {
      expect(item.label, item.href).not.toContain("&");
      const words = item.label.split(" ").slice(1);
      // Only an acronym may be capitalised after the first word ("AI calls").
      for (const w of words) expect(w === w.toLowerCase() || w === w.toUpperCase(), item.label).toBe(true);
    }
  });

  it("keeps the Company and Agency personas as two sections", () => {
    expect(byHref("/companies")?.label).toBe("Companies");
    expect(byHref("/agencies")?.label).toBe("Agencies");
  });

  it("routes and capability gates did not move with the labels", () => {
    expect(byHref("/jobs")?.capability).toBe("read_entities");
    expect(byHref("/transactions")?.capability).toBe("read_entities");
    expect(byHref("/skills/discovery")?.capability).toBe("read_entities");
    expect(byHref("/roles")?.capability).toBeUndefined();
  });
});
