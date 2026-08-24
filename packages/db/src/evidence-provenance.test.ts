/**
 * Every committed evidence artifact must say when it was true and where it came from.
 *
 * The sweep at the bottom is the point. A convention that lives in a code review decays; this
 * walks `docs/registers/` and fails on any artifact that cannot describe itself, so a new audit
 * script cannot ship a bare blob of counts.
 *
 * Scope is deliberately `kind`-bearing files. That marker is what distinguishes a MEASUREMENT
 * from the other JSON under `docs/` (plans, fixtures, configuration), and widening the sweep to
 * every file would turn a real invariant into noise the next author routes around.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  missingProvenance,
  provenance,
  REPOSITORY_ONLY,
  REQUIRED_PROVENANCE_KEYS,
} from "./evidence-provenance";

const AT = new Date("2026-08-24T06:00:00.000Z");

describe("provenance()", () => {
  it("stamps the four required fields", () => {
    const p = provenance({ source: "pnpm x", target: "SUPABASE", readOnly: true, measuredAt: AT });
    expect(p).toEqual({
      measured_at: "2026-08-24T06:00:00.000Z",
      source: "pnpm x",
      target: "SUPABASE",
      read_only: true,
    });
  });

  it("omits the optional fields rather than writing nulls for them", () => {
    // `bypass_rls: undefined` would serialize away silently; an ABSENT key is honest, whereas
    // `bypass_rls: false` would assert something untrue about a repository-only artifact.
    const p = provenance({ source: "s", target: REPOSITORY_ONLY, readOnly: true, measuredAt: AT });
    expect("bypass_rls" in p).toBe(false);
    expect("population_predicate" in p).toBe(false);
  });

  it("keeps role: null, because 'no database role' is a fact worth recording", () => {
    const p = provenance({ source: "s", target: REPOSITORY_ONLY, readOnly: true, role: null, measuredAt: AT });
    expect(p.role).toBeNull();
  });

  it("carries bypass_rls when given — a zero count is not evidence without it", () => {
    const p = provenance({ source: "s", target: "db", readOnly: true, bypassRls: true, measuredAt: AT });
    expect(p.bypass_rls).toBe(true);
  });
});

describe("missingProvenance", () => {
  const good = provenance({ source: "s", target: "t", readOnly: true, measuredAt: AT });

  it("passes a complete header", () => {
    expect(missingProvenance(good)).toEqual([]);
  });

  it("names every missing key on a bare object", () => {
    expect(missingProvenance({})).toEqual([...REQUIRED_PROVENANCE_KEYS]);
  });

  it("rejects a non-object", () => {
    expect(missingProvenance(null)).toEqual([...REQUIRED_PROVENANCE_KEYS]);
    expect(missingProvenance("nope")).toEqual([...REQUIRED_PROVENANCE_KEYS]);
  });

  it("rejects an empty string, which passes a naive presence check", () => {
    expect(missingProvenance({ ...good, source: "   " })).toEqual(["source"]);
  });

  it("rejects read_only of the wrong type — 'true' is not true", () => {
    expect(missingProvenance({ ...good, read_only: "true" })).toEqual(["read_only"]);
  });
});

describe("every committed evidence artifact", () => {
  const root = join(__dirname, "..", "..", "..", "docs", "registers");

  /** Plain recursive walk — a whole dependency for one directory listing is not worth it. */
  const jsonFilesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return jsonFilesUnder(full);
      return e.isFile() && e.name.endsWith(".json") ? [full] : [];
    });

  const files: string[] = jsonFilesUnder(root);

  const artifacts = files
    .map((f: string) => {
      try {
        return { f, json: JSON.parse(readFileSync(f, "utf8")) as unknown };
      } catch {
        return { f, json: null };
      }
    })
    .filter(
      (x: { f: string; json: unknown }): x is { f: string; json: Record<string, unknown> } =>
        typeof x.json === "object" && x.json !== null && "kind" in (x.json as object),
    );

  it("there are artifacts to check — a passing sweep over nothing proves nothing", () => {
    expect(artifacts.length).toBeGreaterThanOrEqual(4);
  });

  it("each one describes when it was true and where it came from", () => {
    const bad = artifacts
      .filter((a: { f: string; json: Record<string, unknown> }) => missingProvenance(a.json).length > 0)
      .map((a: { f: string; json: Record<string, unknown> }) => `${a.f.split(/[\\/]/).pop() ?? a.f}: missing ${missingProvenance(a.json).join(", ")}`);
    expect(bad).toEqual([]);
  });

  it("any artifact naming a database role also says whether it bypassed RLS", () => {
    // The pairing is the invariant, not either field alone: a role without BYPASSRLS reading a
    // FORCE-RLS table returns zero rows, so a reference count is only interpretable with both.
    const bad = artifacts
      .filter((a: { f: string; json: Record<string, unknown> }) => typeof a.json["role"] === "string" && a.json["bypass_rls"] === undefined)
      .map((a: { f: string; json: Record<string, unknown> }) => a.f.split(/[\\/]/).pop());
    expect(bad).toEqual([]);
  });
});
