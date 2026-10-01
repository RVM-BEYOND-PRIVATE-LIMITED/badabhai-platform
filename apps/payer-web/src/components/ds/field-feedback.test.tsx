import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { Input, Select, Textarea } from "./index";
import { describedBy, fieldFeedbackId } from "./forms";

/**
 * M3 — a field's error (or hint) IS the control's accessible description. The DS feedback line
 * carries `${id}-msg` and the control's `aria-describedby` points at it, merged with any ids the
 * caller passes. Announced ONCE: one message per field (the error replaces the hint), a decorative
 * glyph, and no live region — a refused submit moves focus to the field, so an alert here would
 * read the same reason a second time.
 */
const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("describedBy — the caller's ids, then the feedback line, each once", () => {
  it("joins, trims and de-duplicates", () => {
    expect(describedBy(undefined, undefined)).toBeUndefined();
    expect(describedBy("", undefined)).toBeUndefined();
    expect(describedBy(undefined, "pay-msg")).toBe("pay-msg");
    expect(describedBy("pay-note", "pay-msg")).toBe("pay-note pay-msg");
    expect(describedBy("  a   b ", "pay-msg")).toBe("a b pay-msg");
    expect(describedBy("pay-msg", "pay-msg")).toBe("pay-msg");
    expect(describedBy("a b", undefined)).toBe("a b");
  });

  it("the feedback id is derived from the control id", () => {
    expect(fieldFeedbackId("payMin")).toBe("payMin-msg");
  });
});

describe.each([
  ["Input", (p: Record<string, unknown>) => <Input id="f" label="Pay" {...p} />, /<input\b[^>]*>/],
  [
    "Select",
    (p: Record<string, unknown>) => (
      <Select id="f" label="Pay type" {...p}>
        <option value="">—</option>
      </Select>
    ),
    /<select\b[^>]*>/,
  ],
  [
    "Textarea",
    (p: Record<string, unknown>) => <Textarea id="f" label="About" {...p} />,
    /<textarea\b[^>]*>/,
  ],
] as const)("%s — the feedback line is the control's description", (_name, field, tagRe) => {
  const control = (out: string) => out.match(tagRe)![0];

  it("an ERROR is described: the line has the id, the control points at it", () => {
    const out = html(field({ error: "Enter whole rupees, like 20000." }));
    expect(control(out)).toContain('aria-describedby="f-msg"');
    expect(out).toContain('<span id="f-msg" class="bb-field__error">');
    expect(out).toContain("Enter whole rupees, like 20000.");
  });

  it("a HINT is described the same way (one id for whichever line renders)", () => {
    const out = html(field({ hint: "Per month." }));
    expect(control(out)).toContain('aria-describedby="f-msg"');
    expect(out).toContain('<span id="f-msg" class="bb-field__hint">Per month.</span>');
  });

  it("the error REPLACES the hint — the control is never described by two messages", () => {
    const out = html(field({ hint: "Per month.", error: "Too low." }));
    expect(out).not.toContain("Per month.");
    expect(out.match(/id="f-msg"/g)).toHaveLength(1);
  });

  it("the caller's own describedby is KEPT, the feedback line appended (never replaced)", () => {
    const out = html(field({ error: "Too low.", "aria-describedby": "f-note" }));
    expect(control(out)).toContain('aria-describedby="f-note f-msg"');
  });

  it("no feedback line → no description of its own (a caller's id still passes through)", () => {
    expect(control(html(field({})))).not.toContain("aria-describedby");
    expect(control(html(field({ "aria-describedby": "f-note" })))).toContain(
      'aria-describedby="f-note"',
    );
  });

  it("announced ONCE: the line is not a live region and its glyph is decorative", () => {
    const out = html(field({ error: "Too low." }));
    expect(out).not.toMatch(/aria-live|role="alert"|role="status"/);
    expect(out).toMatch(/<i class="ph-fill ph-warning-circle" aria-hidden="true"><\/i>Too low\./);
  });
});
