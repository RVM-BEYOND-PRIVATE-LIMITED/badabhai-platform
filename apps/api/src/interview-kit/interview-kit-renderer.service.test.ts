import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { InterviewKitRenderer } from "./interview-kit-renderer.service";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import type { InterviewKitContent } from "./interview-kit-content";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function makeRenderer(over: Partial<ServerConfig> = {}): InterviewKitRenderer {
  const config = { RESUME_RENDER_ENABLED: true, ...over } as ServerConfig;
  return new InterviewKitRenderer(new PdfRenderer(config));
}

// A kit with hostile-looking content to prove output encoding.
const KIT: InterviewKitContent = {
  trade_key: "cnc_operator",
  display_name: "CNC Operator",
  overview: "Overview <b>bold</b>",
  common_questions: ["What is <script>alert(1)</script>?"],
  practical_questions: ["Practical Q"],
  safety_questions: ["Safety Q"],
  drawing_measurement_questions: ["Drawing Q"],
  skill_checklist: ["Skill A"],
  revise_before: ["Revise X"],
  documents_to_carry: ["Aadhaar"],
  common_mistakes: ["Mistake Y"],
  hinglish_note: "Tip: confident raho",
};

describe("InterviewKitRenderer.buildHtml", () => {
  it("renders all kit sections and the version", () => {
    const html = makeRenderer().buildHtml(KIT, 1);
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("CNC Operator — Interview Kit");
    expect(html).toContain("Trade overview");
    expect(html).toContain("Common interview questions");
    expect(html).toContain("Safety questions");
    expect(html).toContain("Documents to carry");
    expect(html).toContain("Version 1");
    expect(html).toContain("<li>Aadhaar</li>");
  });

  it("HTML-escapes content so no raw <script> reaches the PDF", () => {
    const html = makeRenderer().buildHtml(KIT, 1);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("leaves no unresolved template tokens", () => {
    const html = makeRenderer().buildHtml(KIT, 2);
    expect(html).not.toContain("{{");
    expect(html).not.toContain("}}");
  });
});

describe("InterviewKitRenderer.renderPdf — kill-switch", () => {
  it("returns null and spawns NO subprocess when RESUME_RENDER_ENABLED=false", async () => {
    spawnMock.mockReset();
    const out = await makeRenderer({ RESUME_RENDER_ENABLED: false }).renderPdf(KIT, 1);
    expect(out).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
