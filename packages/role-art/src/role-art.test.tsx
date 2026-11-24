import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import {
  RoleArt,
  ROLE_ART_DATA,
  ROLE_ART_FALLBACK,
  ROLE_ART_KINDS,
  ROLE_ART_MOTIONS,
  ROLE_ART_PALETTE,
  resolveRoleArtKind,
} from "./index";
// @ts-expect-error — a plain Node ESM script, no type declarations.
import { buildArtifacts } from "../scripts/generate.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * #2999 declares the 36 new kinds before their art exists (#3026). Until that PR draws
 * them, every new kind resolves to the generic fallback; this set is deleted there.
 */
const PENDING_ROLE_ART_KINDS: ReadonlySet<string> = new Set([
  "gear_cutting_operator",
  "boring_machine_operator",
  "spm_finishing_operator",
  "cnc_router_operator",
  "fabricator",
  "tube_bending_operator",
  "foundry_operator",
  "die_casting_operator",
  "forging_operator",
  "plating_operator",
  "plastic_extrusion_operator",
  "cmm_operator",
  "ndt_technician",
  "calibration_technician",
  "material_lab_technician",
  "quality_engineer",
  "robot_operator_programmer",
  "instrumentation_technician",
  "hvac_rac_technician",
  "utility_operator",
  "maintenance_engineer",
  "service_engineer",
  "production_engineer",
  "process_engineer",
  "npd_engineer",
  "safety_officer",
  "project_site_engineer",
  "technical_sales_engineer",
  "ppc_engineer",
  "store_keeper",
  "purchase_engineer",
  "dispatch_logistics_executive",
  "forklift_operator",
  "crane_operator",
  "cae_analyst",
  "piping_designer",
]);

const ART_KINDS_WITH_PENDING = [
  ...TRADE_FORM_KINDS_ALL.filter((kind) => !PENDING_ROLE_ART_KINDS.has(kind)),
  ROLE_ART_FALLBACK,
];

describe("role art — coverage", () => {
  it("has art for every declared kind that has a drawing, plus the generic fallback", () => {
    expect([...ROLE_ART_KINDS]).toEqual(ART_KINDS_WITH_PENDING);
    for (const kind of TRADE_FORM_KINDS_ALL) {
      if (PENDING_ROLE_ART_KINDS.has(kind)) {
        expect(resolveRoleArtKind(kind), kind).toBe(ROLE_ART_FALLBACK);
      } else {
        expect(ROLE_ART_DATA[kind as (typeof ROLE_ART_KINDS)[number]], kind).toBeDefined();
      }
    }
  });

  it("art/ORDER lists exactly the drawn kinds in declared order", () => {
    const order = readFileSync(join(PKG, "art", "ORDER"), "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(order).toEqual(ART_KINDS_WITH_PENDING);
  });
});

describe("role art — the generated files are what art/*.svg produces", () => {
  it("every checked-in artifact (TS data, CSS, Dart) is byte-identical to a fresh run", () => {
    const artifacts = buildArtifacts() as Map<string, string>;
    expect(artifacts.size).toBe(3);
    for (const [path, text] of artifacts) {
      expect(readFileSync(path, "utf8").replace(/\r\n/g, "\n"), path).toBe(text);
    }
  });
});

describe("role art — brand + motion rules", () => {
  const hexes = new Set(Object.values(ROLE_ART_PALETTE));

  it("uses only the three brand colours", () => {
    expect([...hexes].sort()).toEqual(["#05194C", "#F3F5F4", "#FFB32C"]);
  });

  it.each(ROLE_ART_KINDS)(
    "%s: a 2–4 s loop with 1–2 moving parts in the shared vocabulary",
    (kind) => {
      const def = ROLE_ART_DATA[kind];
      expect(def.loop).toBeGreaterThanOrEqual(2);
      expect(def.loop).toBeLessThanOrEqual(4);
      const moving = def.parts.filter((p) => p.motion !== null);
      expect(moving.length).toBeGreaterThanOrEqual(1);
      expect(moving.length).toBeLessThanOrEqual(2);
      for (const p of moving) expect(Object.keys(ROLE_ART_MOTIONS)).toContain(p.motion!.type);
      for (const p of def.parts) {
        for (const s of p.shapes) {
          expect([1, 0.8, 0.6, 0.4]).toContain(s.opacity);
          if (s.strokeWidth > 0) expect(s.strokeWidth).toBeGreaterThanOrEqual(4);
        }
      }
    },
  );

  it("every motion's first keyframe is its rest pose (the reduce-motion frame)", () => {
    for (const m of Object.values(ROLE_ART_MOTIONS)) expect(m.keys[0]).toBe(0);
  });
});

describe("resolveRoleArtKind — defensive", () => {
  it.each([null, undefined, "", "not_a_role", "toString", "__proto__", 42, {}, "CNC_TURNER"])(
    "%s → generic",
    (v) => expect(resolveRoleArtKind(v)).toBe("generic"),
  );
  it.each(TRADE_FORM_KINDS_ALL)("%s → itself, or generic until #3026 draws it", (k) =>
    expect(resolveRoleArtKind(k)).toBe(PENDING_ROLE_ART_KINDS.has(k) ? ROLE_ART_FALLBACK : k),
  );
});

describe("<RoleArt>", () => {
  const html = (roleKind: unknown, animated?: boolean) =>
    renderToStaticMarkup(<RoleArt roleKind={roleKind} animated={animated} />);

  it("is decorative, keyed by kind, and stamps the motion custom properties", () => {
    const out = html("welder");
    expect(out).toContain('data-role-art="welder"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("bb-role-art--animated");
    expect(out).toContain('data-part="sparks"');
    expect(out).toContain("bb-role-art__part--blink");
    expect(out).toContain("--ra-dur:2s"); // welder loop 2s, sparks one cycle per loop
    expect(out).not.toMatch(/<text|<title/);
  });

  it("an unknown kind draws the generic art", () => {
    expect(html("nope")).toContain('data-role-art="generic"');
  });

  it("animated={false} drops the animation class (static rest pose)", () => {
    expect(html("welder", false)).not.toContain("bb-role-art--animated");
  });

  it("role-art.css holds every part still under prefers-reduced-motion", () => {
    const css = readFileSync(join(PKG, "role-art.css"), "utf8");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.bb-role-art__part \{\s*animation: none !important;/,
    );
    for (const name of Object.keys(ROLE_ART_MOTIONS)) {
      expect(css).toContain(`@keyframes bb-role-art-${name}`);
    }
  });
});
