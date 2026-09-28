import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { RESUME_SKINS } from "@badabhai/types";

import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import {
  applyResumeSkin,
  RESUME_SKIN_TOKEN_NAMES,
  RESUME_SKIN_TOKENS,
  ResumeSkinError,
  templateTakesSkin,
} from "./resume-skins";
import { getResumeTemplate, RESUME_TEMPLATES } from "./templates/registry";

// A PASS-THROUGH SPY on the swap, so "the renderer applied a skin" is observable even though the
// only skin that exists (Neela) is — by design — a byte-for-byte no-op. Every call still reaches
// the real function.
const swaps = vi.hoisted(() => ({ calls: [] as Array<{ skin: string }> }));
vi.mock("./resume-skins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resume-skins")>();
  return {
    ...actual,
    applyResumeSkin: (skeleton: string, skin: Parameters<typeof actual.applyResumeSkin>[1]) => {
      swaps.calls.push({ skin });
      return actual.applyResumeSkin(skeleton, skin);
    },
  };
});

const TEMPLATES_DIR = join(__dirname, "templates");
const read = (file: string) => readFileSync(join(TEMPLATES_DIR, file), "utf8");

/** The `--name: value` declarations of a skeleton's single `:root` block, in order. */
function rootTokens(html: string): Record<string, string> {
  const open = html.indexOf(":root {");
  const block = html.slice(open, html.indexOf("}", open));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function renderer(): ResumeRenderer {
  return new ResumeRenderer(new PdfRenderer({ RESUME_RENDER_ENABLED: true } as ServerConfig));
}

const INPUT: ResumeRenderInput = {
  templateId: "bb_trade",
  displayName: "Asha Kumari",
  canonicalRole: "CNC Turner",
  location: "Faridabad",
  experienceYears: 6,
  availability: "Available immediately",
  summary: "Six years on Fanuc lathes",
  skills: ["Facing", "Boring"],
  machines: ["CNC lathe"],
  controllers: ["Fanuc"],
  educationLevel: "ITI",
  educationField: "Turner",
  education: [],
  certifications: [],
  responsibilities: [],
  trade: "CNC Turning",
  experiences: [],
  preferredLocations: ["Faridabad"],
  expectedSalary: 22000,
  phone: "+91 98765 43210",
  headlineLine: "CNC Turner · 6 yrs",
  footerMeta: "Ref RK8M2Q",
};

beforeEach(() => {
  swaps.calls.length = 0;
});

describe("Neela IS the shipped house style", () => {
  it("its tokens are exactly the :root colours bb_trade v1 and v2 shipped with", () => {
    for (const file of ["bb_trade.v1.html", "bb_trade.v2.html"]) {
      const shipped = rootTokens(read(file));
      for (const name of RESUME_SKIN_TOKEN_NAMES) {
        expect(shipped[name], `${file} ${name}`).toBe(RESUME_SKIN_TOKENS.neela[name]);
      }
    }
  });

  it("the live bb_trade has exactly one :root block and declares every skin token", () => {
    const html = read(getResumeTemplate("bb_trade").file);
    expect(html.split(":root {").length - 1).toBe(1);
    const shipped = rootTokens(html);
    for (const name of RESUME_SKIN_TOKEN_NAMES) expect(shipped[name], name).toBeDefined();
  });

  it("the width FLOORS are not skin tokens — no skin may thin a printed rule", () => {
    expect(RESUME_SKIN_TOKEN_NAMES as readonly string[]).not.toContain("--rule-w");
    expect(RESUME_SKIN_TOKEN_NAMES as readonly string[]).not.toContain("--hair-w");
  });

  it("every skin in the vocabulary has a complete token block (and only Neela exists)", () => {
    expect([...RESUME_SKINS]).toEqual(["neela"]);
    expect(Object.keys(RESUME_SKIN_TOKENS)).toEqual([...RESUME_SKINS]);
    for (const skin of RESUME_SKINS) {
      expect(Object.keys(RESUME_SKIN_TOKENS[skin])).toEqual([...RESUME_SKIN_TOKEN_NAMES]);
      for (const value of Object.values(RESUME_SKIN_TOKENS[skin])) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe("applyResumeSkin — the :root swap", () => {
  it("applied to the live bb_trade in EVERY skin, it succeeds (the fail-closed throw is unreachable)", () => {
    const html = read(getResumeTemplate("bb_trade").file);
    for (const skin of RESUME_SKINS) expect(() => applyResumeSkin(html, skin)).not.toThrow();
  });

  it("Neela over the shipped bb_trade is BYTE-IDENTICAL to the file", () => {
    for (const file of ["bb_trade.v1.html", "bb_trade.v2.html"]) {
      const html = read(file);
      expect(applyResumeSkin(html, "neela") === html, file).toBe(true);
    }
  });

  it("re-values ONLY the skin tokens, keeping indentation, separators, trailing comments and CRLFs", () => {
    const skeleton = [
      "<style>",
      "  body { color: var(--ink); }",
      "  :root {",
      "    --navy: #000001;",
      "    --ink:#000002; /* ink */",
      "    --muted: #000003;",
      "    --chip-bg: #000004;",
      "    --chip-ink: #000005;",
      "    --rule: #000006;",
      "    --bar-bg: #000007;",
      "    --bar-ink: #000008;",
      "    --paper: #000009;",
      "    --rule-w: 0.75pt; /* floor is 0.5pt */",
      "  }",
      "  .x { border-color: #123456; }",
      "</style>",
    ].join("\r\n");
    const out = applyResumeSkin(skeleton, "neela");
    const n = RESUME_SKIN_TOKENS.neela;
    expect(out).toContain(`    --navy: ${n["--navy"]};\r\n`);
    expect(out).toContain(`    --ink:${n["--ink"]}; /* ink */\r\n`);
    expect(out).toContain(`    --paper: ${n["--paper"]};\r\n`);
    // Not a skin token — untouched. Nor is anything outside the block.
    expect(out).toContain("    --rule-w: 0.75pt; /* floor is 0.5pt */\r\n");
    expect(out).toContain("  body { color: var(--ink); }\r\n");
    expect(out).toContain("  .x { border-color: #123456; }");
    expect(out).not.toMatch(/#00000[1-9]/);
    // Only the values moved: same line count, same everything else.
    expect(out.split("\r\n")).toHaveLength(skeleton.split("\r\n").length);
  });

  it("FAILS CLOSED on a skeleton it cannot skin cleanly — never a half-skinned sheet", () => {
    const full = RESUME_SKIN_TOKEN_NAMES.map((t) => `  ${t}: #000000;`).join("\n");
    expect(() => applyResumeSkin("<style>body{}</style>", "neela")).toThrow(ResumeSkinError);
    expect(() => applyResumeSkin(`:root {\n${full}\n}\n:root {\n${full}\n}`, "neela")).toThrow(
      ResumeSkinError,
    );
    expect(() => applyResumeSkin(`:root {\n  --navy: #000000;\n}`, "neela")).toThrow(
      /does not declare --ink/,
    );
    expect(() => applyResumeSkin(`:root {\n${full}\n`, "neela")).toThrow(ResumeSkinError);
  });

  it("does not mutate the shipped file on disk", () => {
    const file = getResumeTemplate("bb_trade").file;
    const before = read(file);
    renderer().buildResumeHtml({ ...INPUT, skin: "neela" });
    expect(read(file)).toBe(before);
  });
});

describe("templateTakesSkin — bb_trade ONLY", () => {
  it("is true for bb_trade and false for every other layout, unknown ids and none", () => {
    expect(templateTakesSkin("bb_trade")).toBe(true);
    for (const id of [
      ...RESUME_TEMPLATES.map((t) => t.id).filter((id) => id !== "bb_trade"),
      "bb_trade_v9",
      "",
      null,
      undefined,
    ]) {
      expect(templateTakesSkin(id), String(id)).toBe(false);
    }
  });
});

describe("ResumeRenderer — the skin in a real render", () => {
  it("FLAG ON + Neela renders BYTE-IDENTICAL HTML to FLAG OFF (no skin)", () => {
    const off = renderer().buildResumeHtml(INPUT);
    const offNull = renderer().buildResumeHtml({ ...INPUT, skin: null });
    const on = renderer().buildResumeHtml({ ...INPUT, skin: "neela" });
    expect(on === off).toBe(true);
    expect(offNull === off).toBe(true);
    // Not vacuous: this is the trade sheet, with its token block and the worker's data bound in.
    expect(on).toContain("--navy: #0f3d6e;");
    expect(on).toContain("Asha Kumari");
  });

  it("applies the swap for a bb_trade render that carries a skin — and ONLY then", () => {
    renderer().buildResumeHtml(INPUT);
    renderer().buildResumeHtml({ ...INPUT, skin: null });
    expect(swaps.calls).toEqual([]);
    renderer().buildResumeHtml({ ...INPUT, skin: "neela" });
    expect(swaps.calls).toEqual([{ skin: "neela" }]);
  });

  it("every other layout ignores a skin entirely — the swap is never reached", () => {
    for (const templateId of ["bb_general", "classic", "modern", "minimal", "fallback", "nope"]) {
      const without = renderer().buildResumeHtml({ ...INPUT, templateId });
      const withSkin = renderer().buildResumeHtml({ ...INPUT, templateId, skin: "neela" });
      expect(withSkin === without, templateId).toBe(true);
    }
    expect(swaps.calls).toEqual([]);
  });
});
