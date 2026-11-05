import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #2689 FENCE — the old feedback patterns must not come back.
 *
 *  - Non-blocking notices are polite live regions; assertive `role="alert"` stays only on the
 *    full-page error boundary.
 *  - An admin action's success is a toast; an inline result is a failure notice with Retry.
 *  - Forms use the shared inline-validation timing.
 *  - API refusals go through the copy catalogue, never straight from `err.message` to the DOM.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

/** Comments may DISCUSS a forbidden pattern; only code counts. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const NON_BLOCKING_FILES = [
  "app/(portal)/jobs/agency/[jobId]/match-skills/match-skill-form.tsx",
  "app/(portal)/matching/engine/engine-live.tsx",
  "app/(portal)/skills/discovery/[id]/decision-panel.tsx",
  "components/admin-action-result-banner.tsx",
  "components/inline-notice.tsx",
];

const VALIDATED_FORMS = [
  "app/login/login-form.tsx",
  "app/forgot-password/forgot-form.tsx",
  "app/(portal)/account/password-panel.tsx",
  "app/(portal)/account/mfa-panel.tsx",
  "app/(portal)/admins/create-admin-form.tsx",
  "app/(portal)/admins/invite-admin-form.tsx",
  "app/(portal)/accounts/create-login-dialog.tsx",
  "app/(portal)/accounts/account-row-actions.tsx",
  "components/confirm-dialog.tsx",
];

const ADMIN_RESULT_CONSUMERS = [
  "app/(portal)/candidates/[id]/worker-detail-header.tsx",
  "app/(portal)/accounts/account-row-actions.tsx",
  "app/(portal)/accounts/create-login-dialog.tsx",
  "app/(portal)/jobs/[id]/job-detail-header.tsx",
  "components/payer-detail-header.tsx",
  "components/payer-credits-panel.tsx",
];

describe("#2689 · polite notices", () => {
  it.each(NON_BLOCKING_FILES)("%s has no assertive role=alert", (file) => {
    expect(code(read(file))).not.toMatch(/role=["']alert["']/);
  });

  it("keeps assertive alert only on errors that block the whole task", () => {
    // The portal error boundary, a page whose data could not load, and an invite page with no
    // token are all "there is nothing to do on this screen". Everything else is polite.
    const allowed = [
      join("(portal)", "ai-calls", "page.tsx"),
      join("(portal)", "error.tsx"),
      join("invite", "accept", "page.tsx"),
    ];
    const alerts = readdirSync(join(SRC, "app"), { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".tsx"))
      .filter((f) => !f.includes(".test."))
      .filter((f) => /role=["']alert["']/.test(code(read(join("app", f)))));
    expect(alerts.sort()).toEqual(allowed.sort());
  });
});

describe("#2689 · action results", () => {
  it("success is a toast, failure is an inline notice with Retry, and no success banner remains", () => {
    const source = code(read("components/admin-action-result-banner.tsx"));
    expect(source).toContain("useToast");
    expect(source).toContain("successToast");
    expect(source).toContain("InlineNotice");
    expect(source).toContain("Retry");
    expect(source).not.toContain("alert--success");
    expect(source).not.toContain("alert--info");
  });

  it.each(ADMIN_RESULT_CONSUMERS)("%s uses the shared action-result language", (file) => {
    expect(code(read(file))).toContain("AdminActionResultBanner");
  });
});

describe("#2689 · validated forms", () => {
  it.each(VALIDATED_FORMS)("%s uses the shared validation timing", (file) => {
    const source = code(read(file));
    expect(source).toContain("useFormValidation");
    expect(source).toMatch(/onBlur=/);
  });

  it("no admin surface uses a native confirm/alert/prompt", () => {
    const files = readdirSync(SRC, { recursive: true })
      .filter((f): f is string => typeof f === "string" && /\.(tsx?|jsx?)$/.test(f))
      .filter((f) => !f.includes(".test."));
    const offenders = files.filter((f) =>
      /(?:window|globalThis)\.(confirm|alert|prompt)\s*\(/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("#2689 · copy catalogue", () => {
  it("the admin error describer never returns the API's own message", () => {
    const source = code(read("lib/describe-admin-error.ts"));
    expect(source).toContain("adminActionErrorCopy");
    expect(source).not.toMatch(/return\s+err\.message/);
  });

  it("the catalogue has a safe fallback and no status is rendered as the answer", () => {
    const source = read("lib/admin-action-messages.ts");
    expect(source).toContain("SAFE_ACTION_ERROR");
    expect(source).toContain("adminActionErrorCopy");
    expect(source).not.toMatch(/return\s+`?Error\s/);
  });

  it("no Server Action returns an exception's own message to the UI", () => {
    const files = readdirSync(join(SRC, "app"), { recursive: true })
      .filter((f): f is string => typeof f === "string" && /actions\.ts$/.test(f))
      .filter((f) => !f.includes(".test."));
    const offenders = files.filter((f) => /error:\s*err\.message/.test(code(read(join("app", f)))));
    expect(offenders).toEqual([]);
  });
});
