import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";
import { RECORD_WORKER_ID } from "../../../../test/candidate-record";

/**
 * A7 (#2577) — the drawer's phone row: always LOCKED, hidden until revealed, and revealed only
 * through the existing reason-gated route behind A5's T2 confirm, offered to `reveal_pii`.
 *
 * `useState` is seeded POSITIONALLY (source order: phone, asking) and its setters recorded; the
 * ConfirmDialog is a stand-in that records the props it was given.
 */
let seeded: unknown[] = [];
let cursor = 0;
let sets: [number, unknown][] = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = cursor++;
      return [i < seeded.length ? seeded[i] : initial, (v: unknown) => sets.push([i, v])];
    },
  };
});

interface ConfirmProps {
  open: boolean;
  tier: string;
  title: string;
  description: string;
  changes: { label: string; before: string; after: string }[];
  confirmLabel: string;
  categories: { value: string; label: string }[];
  onConfirm: (r: { category: string; text: string }) => Promise<unknown>;
  onClose: () => void;
}
let confirm: ConfirmProps | null = null;
vi.mock("../../../components/confirm-dialog", () => ({
  ConfirmDialog: (p: ConfirmProps) => {
    confirm = p;
    return p.open ? <div data-confirm-open="" /> : null;
  },
}));

const reveal = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ revealCandidatePhoneAction: reveal }));

const { PhoneField, REVEAL_REASON_CATEGORIES } = await import("./phone-reveal");
const { LOCK_REASONS } = await import("./locked-tag");

const PHONE = 0;
const ASKING = 1;

beforeEach(() => {
  seeded = [];
  cursor = 0;
  sets = [];
  confirm = null;
  reveal.mockReset();
});

const html = (canReveal = true) =>
  renderToStaticMarkup(<PhoneField workerId={RECORD_WORKER_ID} canReveal={canReveal} />);

describe("before a reveal", () => {
  it("is hidden and LOCKED, with the reason the phone is locked", () => {
    const out = html();
    expect(out).toContain('<span class="table__meta">Hidden</span>');
    expect(out).toContain('class="lock-tag" role="img" aria-label="Locked"');
    expect(out).toContain(LOCK_REASONS.phone.replace(/'/g, "&#x27;"));
  });

  it("offers Reveal phone to a session holding reveal_pii — and no edit control", () => {
    const out = html(true);
    expect(out).toMatch(/<button type="button" class="btn btn--ghost btn--sm">.*Reveal phone<\/button>/);
    expect(out).not.toMatch(/>\s*Edit\s*</);
  });

  it("tells a role without it that it cannot reveal — no control, no dialog", () => {
    const out = html(false);
    expect(out).not.toContain("Reveal phone");
    expect(out).toContain("Your role cannot reveal contact details.");
    expect(confirm).toBeNull();
  });

  it("the confirm starts closed; the button opens it", () => {
    html(true);
    expect(confirm!.open).toBe(false);
    seeded = [null, true];
    cursor = 0;
    expect(html(true)).toContain("data-confirm-open");
  });
});

describe("the confirm-with-reason (A5's T2)", () => {
  it("is consequential, shows what changes, and asks for one of the API's closed reasons", () => {
    html(true);
    expect(confirm!.tier).toBe("consequential");
    expect(confirm!.changes).toEqual([{ label: "Phone", before: "Hidden", after: "Shown to you" }]);
    expect(confirm!.confirmLabel).toBe("Reveal phone");
    expect(confirm!.categories).toBe(REVEAL_REASON_CATEGORIES);
    expect(REVEAL_REASON_CATEGORIES.map((c) => c.value)).toEqual([
      "worker_support_callback",
      "dispute_resolution",
      "safety_escalation",
    ]);
  });

  it("says honestly what is recorded — the reason — and what is not — the explanation", () => {
    html(true);
    expect(confirm!.description).toContain("The reason you choose is recorded with the reveal");
    expect(confirm!.description).toContain("not stored");
  });

  it("confirming sends this worker, the reason code and the explanation to the reveal action", async () => {
    reveal.mockResolvedValue({ ok: true, phone: "+919800000001" });
    html(true);
    const outcome = await confirm!.onConfirm({
      category: "worker_support_callback",
      text: "Worker asked for a call back",
    });
    expect(reveal).toHaveBeenCalledWith(
      RECORD_WORKER_ID,
      "worker_support_callback",
      "Worker asked for a call back",
    );
    expect(outcome).toEqual({ ok: true, changed: true, message: "Phone revealed." });
    // The phone goes into this field's state — the only place it is kept.
    expect(sets).toContainEqual([PHONE, "+919800000001"]);
  });

  it("a refusal stays in the dialog with its own words, and nothing is revealed", async () => {
    reveal.mockResolvedValue({ ok: false, error: "Nothing was revealed." });
    html(true);
    const outcome = await confirm!.onConfirm({ category: "dispute_resolution", text: "x".repeat(20) });
    expect(outcome).toEqual({ ok: false, error: "Nothing was revealed." });
    expect(sets.some(([slot]) => slot === PHONE)).toBe(false);
  });

  it("closing the dialog closes it", () => {
    html(true);
    confirm!.onClose();
    expect(sets).toEqual([[ASKING, false]]);
  });
});

describe("after a reveal", () => {
  it("shows the phone with its copy button, still locked, and says the reveal was recorded", () => {
    seeded = ["+919800000001", false];
    const out = html(true);
    expect(out).toContain('<span class="mono">+919800000001</span>');
    expect(out).toContain('aria-label="Copy phone"');
    expect(out).toContain('class="lock-tag"');
    expect(out).toContain("Revealed to you. The reveal is recorded with your reason.");
    expect(out).not.toContain("Reveal phone");
  });
});
