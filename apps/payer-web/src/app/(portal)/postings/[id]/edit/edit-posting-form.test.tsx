import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * EditPostingForm tests — the BAND-DOWNGRADE GUARD lives here: an UNTOUCHED vacancies
 * count must be OMITTED from the action input (submitting the prefill hint would make
 * the backend re-derive — and for a "25+" posting DOWNGRADE — the stored band), while
 * a user-changed count IS sent. Also pins: empty optional fields → undefined (kept
 * server-side), client validate() blocks the action, success → router.push to detail.
 *
 * Env is node (no DOM); React state injected via mocked useState (source order:
 * roleTitle, locationLabel, vacancies, description, error); useTransition runs inline.
 */

const updatePostingAction = vi.fn();
const push = vi.fn();

vi.mock("./actions", () => ({
  updatePostingAction: (i: unknown) => updatePostingAction(i),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (p: string) => push(p) }) }));

let stateQueue: unknown[] = [];
let stateCursor = 0;
let setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const setter = vi.fn();
  setters[i] = setter;
  return [seeded, setter] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    // Run the transition callback INLINE so the submit path is awaitable in the test.
    useTransition: () => [false, (fn: () => void) => fn()] as const,
  };
});

const { EditPostingForm } = await import("./edit-posting-form");

const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";
const INITIAL = {
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  vacanciesHint: 26, // a "25+" posting's band-representative seed
  description: null,
};

function findForm(node: ReactNode): ReactElement<{ onSubmit: (e: unknown) => void }> | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = findForm(c);
      if (f) return f;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === "form") return el as ReactElement<{ onSubmit: (e: unknown) => void }>;
  // The DS Card wrapper is a HOOKLESS pure component — expand it one level (call the
  // function) so the <form> inside stays reachable. Inputs/Buttons are never expanded.
  if (typeof el.type === "function" && (el.type as { name?: string }).name === "Card") {
    return findForm((el.type as (p: unknown) => ReactNode)(el.props));
  }
  if (typeof el.type === "function") return null; // never invoke other (hooked) children
  return el.props && "children" in el.props ? findForm(el.props.children) : null;
}

function render(state: {
  roleTitle?: string;
  locationLabel?: string;
  vacancies?: string;
  description?: string;
}) {
  stateQueue = [
    state.roleTitle ?? INITIAL.roleTitle,
    state.locationLabel ?? INITIAL.locationLabel,
    state.vacancies ?? String(INITIAL.vacanciesHint),
    state.description ?? "",
    null, // error
  ];
  stateCursor = 0;
  setters = [];
  return EditPostingForm({ postingId: POSTING_ID, initial: INITIAL }) as ReactElement;
}

async function submit(tree: ReactElement) {
  const form = findForm(tree);
  expect(form).not.toBeNull();
  await form!.props.onSubmit({ preventDefault: () => undefined });
}

beforeEach(() => {
  updatePostingAction.mockReset().mockResolvedValue({ ok: true, posting: {} });
  push.mockReset();
});

describe("EditPostingForm — the band-downgrade guard (vacancies omission)", () => {
  it("an UNTOUCHED count is OMITTED from the action input (never re-derives the band)", async () => {
    await submit(render({}));
    expect(updatePostingAction).toHaveBeenCalledTimes(1);
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.vacancies).toBeUndefined();
    expect(input.roleTitle).toBe("CNC Machinist");
  });

  it("a USER-CHANGED count IS sent as a number", async () => {
    await submit(render({ vacancies: "30" }));
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.vacancies).toBe(30);
  });

  it("emptied optional fields thread as undefined (kept server-side, never sent as '')", async () => {
    await submit(render({ locationLabel: "", description: "" }));
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.locationLabel).toBeUndefined();
    expect(input.description).toBeUndefined();
  });
});

describe("EditPostingForm — validation + outcomes", () => {
  it("client validate() blocks the action on a too-short role title", async () => {
    await submit(render({ roleTitle: "x" }));
    expect(updatePostingAction).not.toHaveBeenCalled();
    // The error setter (source index 4) received the validation message.
    expect(setters[4]).toHaveBeenCalledWith("Role title must be at least 2 characters.");
  });

  it("a PII-looking description is blocked client-side (parity with the server refine)", async () => {
    await submit(render({ description: "call 9876543210" }));
    expect(updatePostingAction).not.toHaveBeenCalled();
  });

  it("success routes back to the posting detail; failure surfaces the action error", async () => {
    await submit(render({}));
    expect(push).toHaveBeenCalledWith(`/postings/${POSTING_ID}`);

    updatePostingAction.mockResolvedValue({ ok: false, error: "No changes to save." });
    await submit(render({}));
    expect(setters[4]).toHaveBeenCalledWith("No changes to save.");
  });
});
