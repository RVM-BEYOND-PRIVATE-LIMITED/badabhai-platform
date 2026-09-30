import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * EditPostingForm tests (PR-B) — the BAND-DOWNGRADE GUARD still lives here: an UNTOUCHED vacancies
 * count is OMITTED from the action input, a changed one is sent. Also pins: empty optionals →
 * undefined, `initial` threaded to the action (the clear diff), success → router.push to detail,
 * client validate() blocks. Env is node; state injected via mocked useState (source order: fields,
 * requirements, benefits, reqDraft, benDraft, error, selection, preview); useTransition runs inline.
 */

const updatePostingAction = vi.fn();
const push = vi.fn();

vi.mock("./actions", () => ({ updatePostingAction: (i: unknown) => updatePostingAction(i) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (p: string) => push(p) }) }));
// The interactive picker is only rendered on the draft path; stub it hookless.
vi.mock("../../new/match-skill-picker", () => ({ MatchSkillPicker: () => ({ type: "div", props: {} }) }));

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
    useTransition: () => [false, (fn: () => void) => fn()] as const,
  };
});

const { EditPostingForm } = await import("./edit-posting-form");

const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";
const INITIAL = {
  roleTitle: "CNC Machinist",
  vacanciesHint: 26,
  locationLabel: "Pune, MH",
  description: null,
  roleKind: null,
  city: null,
  area: null,
  payMin: null,
  payMax: null,
  payType: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  shift: null,
  neededBy: null,
  requirements: [],
  benefits: [],
};

const BLANK_FIELDS = {
  roleTitle: "CNC Machinist",
  roleKind: "",
  locationLabel: "Pune, MH",
  vacancies: "26",
  city: "",
  area: "",
  payMin: "",
  payMax: "",
  payType: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  shift: "",
  neededBy: "",
  description: "",
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
  if (typeof el.type === "function") return null; // never invoke hooked children
  return el.props && "children" in el.props ? findForm(el.props.children) : null;
}

function render(overrides: Partial<typeof BLANK_FIELDS>, status = "open") {
  stateQueue = [
    { ...BLANK_FIELDS, ...overrides }, // fields
    [], // requirements
    [], // benefits
    "", // reqDraft
    "", // benDraft
    null, // error
    { matchSkillIds: [], untickedRelatedIds: [] }, // selection
    null, // preview
  ];
  stateCursor = 0;
  setters = [];
  return EditPostingForm({ postingId: POSTING_ID, status, initial: INITIAL }) as ReactElement;
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

  it("threads the prior `initial` to the action (the clear diff)", async () => {
    await submit(render({}));
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.initial).toBe(INITIAL);
  });
});

describe("EditPostingForm — card fields + validation", () => {
  it("threads role/city/pay/shift to the action; pay is passed straight through", async () => {
    await submit(
      render({
        roleKind: "cnc_turner",
        city: "Pune",
        payMin: "20000",
        payMax: "35000",
        shift: "rotational",
        neededBy: "immediate",
      }),
    );
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.roleKind).toBe("cnc_turner");
    expect(input.city).toBe("Pune");
    expect(input.payMin).toBe(20000);
    expect(input.payMax).toBe(35000);
    expect(input.shift).toBe("rotational");
    expect(input.neededBy).toBe("immediate");
  });

  it("client validate() blocks the action on a too-short role title (error setter fires)", async () => {
    await submit(render({ roleTitle: "x" }));
    expect(updatePostingAction).not.toHaveBeenCalled();
    // error is state index 5.
    expect(setters[5]).toHaveBeenCalledWith("Role title must be at least 2 characters.");
  });

  it("an inverted pay band (max < min) is blocked client-side", async () => {
    await submit(render({ payMin: "40000", payMax: "20000" }));
    expect(updatePostingAction).not.toHaveBeenCalled();
    expect(setters[5]).toHaveBeenCalledWith("Max pay must be greater than or equal to min pay.");
  });

  it("a PII-looking description is blocked client-side", async () => {
    await submit(render({ description: "call 9876543210" }));
    expect(updatePostingAction).not.toHaveBeenCalled();
  });
});

describe("EditPostingForm — outcomes", () => {
  it("success routes back to the posting detail; failure surfaces the action error", async () => {
    await submit(render({}));
    expect(push).toHaveBeenCalledWith(`/postings/${POSTING_ID}`);

    updatePostingAction.mockResolvedValue({ ok: false, error: "No changes to save." });
    await submit(render({}));
    expect(setters[5]).toHaveBeenCalledWith("No changes to save.");
  });
});
