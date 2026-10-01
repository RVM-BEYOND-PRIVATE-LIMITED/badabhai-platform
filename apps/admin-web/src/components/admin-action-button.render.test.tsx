import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminActionButton } from "./admin-action-button";

/**
 * What `AdminActionButton` renders BEFORE any interaction.
 *
 * This app's vitest environment is `node` (no jsdom/`@testing-library`, see
 * `vitest.config.ts`), the same constraint every other stateful client component in this repo
 * lives with (`login-form.tsx`, `sign-out-button.tsx` have no interaction tests either — only
 * the Server Actions they call do). So this asserts the INITIAL, unarmed contract:
 *   - the label shown is `label`, never `confirmLabel`
 *   - it starts as a quiet ghost button, never pre-armed in the destructive tone
 *   - `disabled` is honoured
 *   - no Cancel control exists until the button has been armed
 *   - it renders NO result copy of its own, in any state (the banner owns that)
 *
 * The arm → confirm → fire sequence is exercised by hand in the running app and is the one
 * gap flagged in the PR description; it would benefit from `@testing-library/react` + jsdom,
 * which is a new dependency this task deliberately did not add without an Architect call.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("AdminActionButton — initial render", () => {
  it("shows `label`, not `confirmLabel`, before any click", () => {
    const out = html(
      <AdminActionButton label="Suspend" confirmLabel="Confirm suspend?" action={async () => ({ ok: true, changed: true, message: "" })} />,
    );
    expect(out).toContain(">Suspend<");
    expect(out).not.toContain("Confirm suspend?");
  });

  it("starts as a quiet ghost button regardless of the confirm variant", () => {
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        variant="danger"
        action={async () => ({ ok: true, changed: true, message: "" })}
      />,
    );
    expect(out).toContain("btn--ghost");
    expect(out).not.toContain("btn--danger");
  });

  it("honours `disabled`", () => {
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        disabled
        action={async () => ({ ok: true, changed: true, message: "" })}
      />,
    );
    expect(out).toContain("disabled=\"\"");
  });

  it("renders no Cancel control before any interaction", () => {
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        action={async () => ({ ok: true, changed: true, message: "" })}
      />,
    );
    expect(out).not.toContain(">Cancel<");
  });

  it("owns NO result copy — no alert region for a failure to be printed into", () => {
    // The button reports through `onSettled` only; `AdminActionResultBanner` (rendered by
    // every caller) is the single owner of both success and failure copy. When the button
    // also kept its own `error` state, a 409 rendered twice — inline AND in the banner.
    // There is no state of this component that produces an alert, so this holds in all of
    // them and fails the moment an inline error is reintroduced.
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        action={async () => ({ ok: false, error: "Cannot suspend yourself" })}
      />,
    );
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain("admin-action__error");
    expect(out).not.toContain("aria-describedby");
  });

  it("is wrapped in a live region, so the arm→confirm label swap is announced", () => {
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        action={async () => ({ ok: true, changed: true, message: "" })}
      />,
    );
    expect(out).toContain('aria-live="polite"');
  });
});

describe("AdminActionButton — icon and per-row name (owner brief 2026-10-01)", () => {
  const ok = async () => ({ ok: true as const, changed: true, message: "" });

  it("draws its glyph before the label, decorative, from the shared icon font", () => {
    const out = html(
      <AdminActionButton label="Suspend" confirmLabel="Confirm suspend?" icon="prohibit" action={ok} />,
    );
    expect(out).toContain(
      '<i class="ph-fill ph-prohibit" aria-hidden="true"></i><span>Suspend</span>',
    );
  });

  it("keeps the glyph when disabled — the button recolours it, nothing else", () => {
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        icon="prohibit"
        disabled
        action={ok}
      />,
    );
    expect(out).toContain('disabled=""');
    expect(out).toContain("ph-prohibit");
  });

  it("names the row's subject to assistive tech, after the visible label", () => {
    const out = html(
      <AdminActionButton
        label="Suspend"
        confirmLabel="Confirm suspend?"
        subject="admin aaaaaaaa…"
        action={ok}
      />,
    );
    // The accessible name is the button's text: "Suspend admin aaaaaaaa…" — it starts with the
    // visible label (WCAG 2.5.3, label in name).
    expect(out).toContain('<span>Suspend</span><span class="sr-only"> admin aaaaaaaa…</span>');
    expect(out).not.toContain("aria-label");
  });

  it("renders no icon and no hidden text when given neither", () => {
    const out = html(<AdminActionButton label="Suspend" confirmLabel="Confirm suspend?" action={ok} />);
    expect(out).not.toContain("ph-fill");
    expect(out).not.toContain("sr-only");
  });
});
