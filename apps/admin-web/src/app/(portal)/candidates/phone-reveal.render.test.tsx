import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";
import { RECORD_WORKER_ID } from "../../../../test/candidate-record";

/**
 * A7 (#2577) — the drawer's phone row: always LOCKED, hidden until revealed, and revealed only
 * through the existing reason-gated route behind A5's T2 confirm, offered to `reveal_pii`.
 *
 * `useState` is seeded POSITIONALLY (source order: phone, asking) and its setters recorded; the
 * ConfirmDialog is a stand-in that records the props it was given. `useRef` hands out plain
 * objects, recorded in call order: the field's own ref (the revealed value) is the first.
 */
let seeded: unknown[] = [];
let cursor = 0;
let sets: [number, unknown][] = [];
let refs: { current: unknown }[] = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = cursor++;
      return [i < seeded.length ? seeded[i] : initial, (v: unknown) => sets.push([i, v])];
    },
    useRef: (initial: unknown) => {
      const ref = { current: initial };
      refs.push(ref);
      return ref;
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
  returnFocus?: () => unknown;
}
let confirm: ConfirmProps | null = null;
vi.mock("../../../components/confirm-dialog", () => ({
  ConfirmDialog: (p: ConfirmProps) => {
    confirm = p;
    return p.open ? <div data-confirm-open="" /> : null;
  },
}));

const reveal = vi.hoisted(() => vi.fn());
vi.mock("./phone-reveal-model", () => ({ requestPhoneReveal: reveal }));

const { PhoneField, REVEAL_REASON_CATEGORIES } = await import("./phone-reveal");
const { LOCK_REASONS } = await import("./locked-tag");

const PHONE = 0;
const ASKING = 1;

beforeEach(() => {
  seeded = [];
  cursor = 0;
  sets = [];
  refs = [];
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

  it("confirming sends this worker, the reason code and the explanation to the reveal route", async () => {
    reveal.mockResolvedValue({ ok: true, phone: "+919800000001" });
    html(true);
    const outcome = await confirm!.onConfirm({
      category: "worker_support_callback",
      text: "Worker asked for a call back",
    });
    expect(reveal).toHaveBeenCalledWith(RECORD_WORKER_ID, {
      category: "worker_support_callback",
      text: "Worker asked for a call back",
    });
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

/**
 * The success REPLACES the button that opened the confirm. Were the confirm inside the hidden
 * state, it would be unmounted with that button — no exit, and focus handed back to a detached
 * button, which drops it on the page body. It is rendered beside both states instead, so it
 * CLOSES, and the focus it hands back goes to the revealed phone's Copy button.
 */
describe("focus after a reveal", () => {
  it("the confirm is still there once the phone is revealed — closed, so it closes rather than vanishes", () => {
    seeded = ["+919800000001", false];
    html(true);
    expect(confirm).not.toBeNull();
    expect(confirm!.open).toBe(false);
  });

  it("…and hands focus to the revealed phone's Copy button", () => {
    seeded = ["+919800000001", false];
    html(true);
    const copy = { name: "Copy phone" };
    // The revealed value, as React would have attached it: the phone, and its Copy button.
    refs[0]!.current = { querySelector: (s: string) => (s === "button" ? copy : null) };
    expect(confirm!.returnFocus!()).toBe(copy);
  });

  it("before a reveal (Cancel, a refusal) it names nothing — focus goes back to Reveal phone", () => {
    html(true);
    expect(refs[0]!.current).toBeNull();
    expect(confirm!.returnFocus!()).toBeNull();
  });

  it("a role that cannot reveal still has no confirm, in either state", () => {
    html(false);
    expect(confirm).toBeNull();
    seeded = ["+919800000001", false];
    cursor = 0;
    html(false);
    expect(confirm).toBeNull();
  });
});
