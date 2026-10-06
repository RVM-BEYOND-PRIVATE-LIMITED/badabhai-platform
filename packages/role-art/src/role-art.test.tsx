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

describe("role art — coverage", () => {
  it("has art for EVERY declared role kind, plus the generic fallback, and nothing else", () => {
    expect([...ROLE_ART_KINDS]).toEqual([...TRADE_FORM_KINDS_ALL, ROLE_ART_FALLBACK]);
    for (const kind of TRADE_FORM_KINDS_ALL) expect(ROLE_ART_DATA[kind], kind).toBeDefined();
  });

  it("art/ORDER lists exactly the declared kinds in declared order", () => {
    const order = readFileSync(join(PKG, "art", "ORDER"), "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(order).toEqual([...TRADE_FORM_KINDS_ALL, "generic"]);
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
  it.each(TRADE_FORM_KINDS_ALL)("%s → itself", (k) => expect(resolveRoleArtKind(k)).toBe(k));
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
    expect(out).toContain("--ra-dur:1s"); // welder loop 2s, sparks rate 2
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
