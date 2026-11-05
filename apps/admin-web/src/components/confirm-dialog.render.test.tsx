import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

/**
 * A5 (#2575) — the T2 / T3 confirm dialogs as rendered. The gates themselves are pinned in
 * lib/confirm-tiers.test.ts and the dialog chrome in dialog.render.test.tsx; this pins what the
 * operator sees and what the confirm button allows, and that a T3 hands Cancel to the dialog as
 * the place focus starts.
 *
 * `useState` is seeded POSITIONALLY (source order: draft, failure) to render a filled-in dialog;
 * the Dialog is a stand-in that renders its body + footer and records its props.
 */
let seeded: unknown[] = [];
let cursor = 0;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = cursor++;
      return [i < seeded.length ? seeded[i] : initial, () => {}];
    },
  };
});

interface DialogStandInProps {
  title: string;
  children: ReactNode;
  footer: ReactElement<{ children: ReactElement<{ className?: string; ref?: unknown }>[] }>;
  initialFocusRef?: RefObject<HTMLElement | null>;
}
let dialogProps: DialogStandInProps | null = null;
vi.mock("./dialog", () => ({
  Dialog: (p: DialogStandInProps) => {
    dialogProps = p;
    return (
      <div data-dialog={p.title}>
        {p.children}
        {p.footer}
      </div>
    );
  },
}));

const { ConfirmDialog } = await import("./confirm-dialog");

const ok = async () => ({ ok: true as const, changed: true, message: "" });
const CHANGES = [{ label: "Status", before: "Active", after: "Suspended" }];
const REASON = "Repeated fake postings reported";

beforeEach(() => {
  seeded = [];
  cursor = 0;
  dialogProps = null;
});

const t2 = () =>
  renderToStaticMarkup(
    <ConfirmDialog
      open
      onClose={() => {}}
      tier="consequential"
      title="Suspend payer"
      changes={CHANGES}
      confirmLabel="Suspend payer"
      onConfirm={ok}
    />,
  );
const t3 = () =>
  renderToStaticMarkup(
    <ConfirmDialog
      open
      onClose={() => {}}
      tier="destructive"
      title="Archive company"
      changes={[{ label: "Status", before: "Active", after: "Archived" }]}
      targetName="Acme Steel"
      confirmLabel="Archive company"
      onConfirm={ok}
    />,
  );

/** The confirm (last) button's opening tag. */
const confirmButton = (out: string) =>
  [...out.matchAll(/<button[^>]*>/g)].map((m) => m[0]).at(-1) ?? "";

describe("T2 consequential", () => {
  it("shows the before/after diff", () => {
    const out = t2();
    expect(out).toContain('<table class="diff"><caption class="sr-only">What changes</caption>');
    expect(out).toContain(
      '<tr><th scope="row">Status</th><td class="diff__before">Active</td><td class="diff__after">Suspended</td></tr>',
    );
  });

  it("asks for a reason category and an explanation of at least 15 characters", () => {
    const out = t2();
    expect(out).toContain("Choose a category");
    expect(out).toContain(">Fraud or abuse</option>");
    expect(out).toMatch(/<textarea[^>]*minLength="15"/);
    expect(out).toContain("0 of at least 15 characters");
  });

  it("asks for no typed name", () => {
    expect(t2()).not.toContain("to confirm");
  });

  it("starts with confirm disabled, naming the first missing thing", () => {
    const out = t2();
    expect(confirmButton(out)).toContain('class="btn btn--primary" disabled=""');
    expect(out).toContain("Choose a reason category.");
  });

  it("enables confirm once the reason is complete", () => {
    seeded = [{ category: "fraud", reason: REASON, typedName: "" }];
    const out = t2();
    expect(confirmButton(out)).not.toContain("disabled");
    expect(out).not.toContain("overlay__hint");
    expect(out).toContain(`${REASON.length} of at least 15 characters`);
  });

  it("lets focus start where the dialog puts it by default", () => {
    t2();
    expect(dialogProps!.initialFocusRef).toBeUndefined();
  });

  it("keeps a failure inside the dialog, with the server's own text", () => {
    seeded = [
      { category: "fraud", reason: REASON, typedName: "" },
      { ok: false, error: "Payer already suspended." },
    ];
    const out = t2();
    expect(out).toContain('<div class="alert alert--danger" role="alert">');
    expect(out).toContain("Payer already suspended.");
  });
});

describe("T3 destructive", () => {
  it("is T2 plus typing the target's name, in the danger tone", () => {
    const out = t3();
    expect(out).toContain("diff__before");
    expect(out).toContain("Choose a category");
    expect(out).toContain('Type <strong class="confirm__name">Acme Steel</strong> to confirm');
    expect(confirmButton(out)).toContain('class="btn btn--danger" disabled=""');
  });

  it("stays disabled with the reason given until the name matches", () => {
    seeded = [{ category: "security", reason: REASON, typedName: "Acme" }];
    let out = t3();
    expect(confirmButton(out)).toContain("disabled");
    expect(out).toContain("Type the name exactly to confirm.");
    cursor = 0;
    seeded = [{ category: "security", reason: REASON, typedName: "Acme Steel" }];
    out = t3();
    expect(confirmButton(out)).not.toContain("disabled");
  });

  it("starts focus on Cancel", () => {
    t3();
    const focusRef = dialogProps!.initialFocusRef;
    expect(focusRef).toBeDefined();
    const buttons = dialogProps!.footer.props.children.filter(
      (c) => c && typeof c === "object" && "props" in c,
    );
    const cancel = buttons.find((b) => b.props.className === "btn btn--ghost");
    expect(cancel?.props.ref).toBe(focusRef);
  });
});
