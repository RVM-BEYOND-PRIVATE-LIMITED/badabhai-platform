import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { maskInitials } from "./mask-initials";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";

// Never spawn the real WeasyPrint binary — buildResumeHtml is pure, but the renderer
// pulls in PdfRenderer which imports child_process.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function makeRenderer(): ResumeRenderer {
  return new ResumeRenderer(new PdfRenderer({ RESUME_RENDER_ENABLED: true } as ServerConfig));
}

describe("maskInitials — employer-facing identity mask (decision eafcccc, build gate B-G)", () => {
  it("matches the decision's canonical golden example: 'Ramesh Kumar' -> 'R***** K.'", () => {
    expect(maskInitials("Ramesh Kumar")).toBe("R***** K.");
  });

  it("masks a single-token name with stars, no trailing dot", () => {
    expect(maskInitials("Ravi")).toBe("R***");
  });

  it("normalises case and collapses internal whitespace", () => {
    expect(maskInitials("asha   kumari")).toBe("A*** K.");
  });

  it("handles three+ tokens: first starred, every subsequent token initial-dot", () => {
    expect(maskInitials("Mohammed Imran Khan")).toBe("M******* I. K.");
  });

  it("single-character first token degrades to the bare initial (no stars)", () => {
    expect(maskInitials("A Kumar")).toBe("A K.");
  });

  it("returns null for null / undefined / empty / whitespace-only (render name-less, no fallback leak)", () => {
    expect(maskInitials(null)).toBeNull();
    expect(maskInitials(undefined)).toBeNull();
    expect(maskInitials("")).toBeNull();
    expect(maskInitials("   ")).toBeNull();
  });

  it("never returns the raw name", () => {
    const raw = "Ramesh Kumar";
    expect(maskInitials(raw)).not.toContain("amesh");
    expect(maskInitials(raw)).not.toContain("Kumar");
  });
});

describe("B-G golden-render: the resume renderer masks when fed maskInitials(realName)", () => {
  const BASE: ResumeRenderInput = {
    templateId: "classic",
    displayName: null,
    canonicalRole: "VMC Operator",
    location: "Pune",
    experienceYears: 5,
    availability: "Available immediately",
    summary: "5 years on Fanuc controls",
    skills: ["fanuc", "vmc"],
    machines: ["VMC"],
    controllers: [],
    education: [],
    certifications: [],
    responsibilities: ["Operate VMC to drawing"],
  };

  it("renders the masked initials and NEVER the raw name or any phone", () => {
    const realName = "Ramesh Kumar";
    const realPhone = "9876543210"; // sentinel — must never be in the employer render
    const html = makeRenderer().buildResumeHtml({ ...BASE, displayName: maskInitials(realName) });

    // The mask is present…
    expect(html).toContain("R***** K.");
    // …and the raw name is absent (no token of it leaks).
    expect(html).not.toContain("Ramesh");
    expect(html).not.toContain("Kumar");
    // No phone anywhere (employer resume carries no contact — ADR-0010).
    expect(html).not.toContain(realPhone);
    expect(html).not.toMatch(/(\+?91)?[6-9]\d{9}/);
  });
});
