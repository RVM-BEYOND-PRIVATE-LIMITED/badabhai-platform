import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * #2688 — FEEDBACK DISCIPLINE FENCE.
 *
 * The old patterns are gone for good: no native confirm (the browser's own beforeunload prompt
 * stays), no bespoke error paragraph in the audited screens, no inline danger Toast in the
 * capacity/credits panels, and no direct render of a server action's error. Every audited screen
 * goes through the shared InlineNotice / FieldFeedback primitive and the copy catalogues.
 */
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const source = (path: string) => stripComments(readFileSync(join(srcRoot, path), "utf8"));

const AUDITED = [
  "app/(portal)/agency/dashboard/agency-job-form.tsx",
  "app/(portal)/agency/dashboard/batch-invite-panel.tsx",
  "app/(portal)/agency/dashboard/invite-panel.tsx",
  "app/(portal)/agency/qr/qr-invite.tsx",
  "app/(portal)/postings/[id]/edit/edit-posting-form.tsx",
  "app/(portal)/postings/ai/new/job-posting-chat.tsx",
  "app/(portal)/postings/new/match-skill-picker.tsx",
  "app/(portal)/postings/new/posting-form.tsx",
  "app/(portal)/postings/trade-fields.tsx",
  "app/(portal)/postings/trade-picker.tsx",
  "components/chip-editor.tsx",
  "components/ds/select-menu.tsx",
] as const;

const OLD_CLASSES = [
  "posting-actions__msg--danger",
  "agency-invite__error",
  "match-picker__error",
  "trade-fields__error",
  "ai-chat-status__error",
  "chip-editor__error",
] as const;

describe("#2688 — no native confirm for in-app navigation", () => {
  it("use-posting-draft never calls window.confirm", () => {
    expect(source("components/use-posting-draft.ts")).not.toContain("window.confirm");
  });

  it("lib/posting-draft leaves tab-close to the native beforeunload prompt only", () => {
    const draft = source("lib/posting-draft.ts");
    expect(draft).toContain("beforeunload");
    expect(draft).not.toContain("window.confirm");
  });
});

describe("#2688 — the audited screens use the shared notice/field feedback", () => {
  it.each(AUDITED)("%s renders InlineNotice or FieldFeedback", (path) => {
    const file = source(path);
    expect(file).toMatch(/\bInlineNotice\b|\bFieldFeedback\b/);
  });

  it.each(AUDITED)("%s has no bespoke error paragraph class", (path) => {
    const file = source(path);
    for (const cls of OLD_CLASSES) expect(file).not.toContain(cls);
  });

  it.each(AUDITED)("%s never renders a server action error directly", (path) => {
    const file = source(path);
    for (const bad of [
      "setError(res.error)",
      "setError(order.error)",
      "setError(verified.error)",
      "unlockError: res.error",
      "contactError: res.error",
      "resumeError: res.error",
    ]) {
      expect(file).not.toContain(bad);
    }
  });

  it("the old error rules are gone from the stylesheet", () => {
    const css = stripComments(readFileSync(join(srcRoot, "app/globals.css"), "utf8"));
    for (const cls of OLD_CLASSES) expect(css).not.toContain(`.${cls}`);
  });
});

describe("#2688 — capacity and credits do not render inline Toasts", () => {
  it.each(["app/(portal)/capacity/capacity-panel.tsx", "app/(portal)/credits/credits-panel.tsx"])(
    "%s routes persistent failures through InlineNotice",
    (path) => {
      const file = source(path);
      expect(file).toContain("InlineNotice");
      expect(file).not.toMatch(/<Toast\b/);
    },
  );
});
