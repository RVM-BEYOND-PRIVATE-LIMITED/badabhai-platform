import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { IconButtonBase } from "@badabhai/icons/button";

/**
 * EditPostingForm tests (PR-B) — the BAND-DOWNGRADE GUARD still lives here: an UNTOUCHED vacancies
 * count is OMITTED from the action input, a changed one is sent. Also pins: empty optionals →
 * undefined, `initial` threaded to the action (the clear diff), success → the detail (through the
 * shared navigation helper, naming the posting for the shell's "Opening …" cue),
 * client validate() blocks. Env is node; state injected via mocked useState (source order: fields,
 * requirements, benefits, reqDraft, benDraft, error, trade, preview, revealed); useTransition
 * runs inline. The card fields reach the action through the shared `readCardForm` — the same read
 * the preview draws — so the liveness fixes are pinned here at the submit end.
 */

const updatePostingAction = vi.fn();
// The save navigates through components/portal-navigation.ts (its router mechanics — push, the
// refresh, the cue — are that module's own suite); here: where to, named what, refreshed or not.
const navigate = vi.fn();

vi.mock("./actions", () => ({ updatePostingAction: (i: unknown) => updatePostingAction(i) }));
vi.mock("../../../../../components/portal-navigation", () => ({
  usePortalNavigation: () => ({ pending: false, navigate }),
}));
// The interactive picker is only rendered on the draft path; stub it hookless.
vi.mock("../../new/match-skill-picker", () => ({
  MatchSkillPicker: () => ({ type: "div", props: {} }),
}));

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
// W4 — the local draft + leave guard runs effects (a real hook outside a render); its rules are
// lib/posting-draft.test.ts's and components/use-posting-draft.test.ts's. Here it is idle (nothing
// saved yet; restored only when a test says so) and keeps the options the form called it with.
const discardDraft = vi.fn();
const draftHook = { restored: false, storageKey: "" };
vi.mock("../../../../../components/use-posting-draft", () => ({
  usePostingDraft: (options: { storageKey: string }) => {
    draftHook.storageKey = options.storageKey;
    return { saved: false, restored: draftHook.restored, discard: discardDraft };
  },
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  // The DS fields mint their auto ids with `useId`, which needs a renderer; the walks below call
  // them as plain functions, so it answers from a counter (unique per call, like the hook).
  let ids = 0;
  return {
    ...actual,
    useId: () => `:r${(ids += 1)}:`,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => [false, (fn: () => void) => fn()] as const,
  };
});

const { EditPostingForm } = await import("./edit-posting-form");

/** The posting a successful save returns (only its title reaches the navigation's cue). */
const SAVED = { roleTitle: "CNC Machinist" };
/** Where a successful save lands, named for the cue — and refreshed (no pre-save Back). */
const LANDING = { pendingLabel: "CNC Machinist", refresh: true };

const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";
/** The signed-in payer (the page passes the session's opaque id). */
const PAYER_ID = "11111111-1111-4111-8111-111111111111";
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

function render(
  overrides: Partial<typeof BLANK_FIELDS>,
  status = "open",
  chips: {
    requirements?: string[];
    benefits?: string[];
    reqDraft?: string;
    benDraft?: string;
  } = {},
  selection = { matchSkillIds: [] as string[], untickedRelatedIds: [] as string[] },
  appended: {
    navigating?: boolean;
    problem?: { control: string; message: string } | null;
    error?: string | null;
    submitting?: "save" | "publish" | null;
  } = {},
) {
  stateQueue = [
    { ...BLANK_FIELDS, ...overrides }, // fields
    chips.requirements ?? [], // requirements
    chips.benefits ?? [], // benefits
    chips.reqDraft ?? "", // reqDraft
    chips.benDraft ?? "", // benDraft
    appended.error ?? null, // error
    selection, // selection
    null, // preview
    {}, // revealed (8)
    appended.navigating ?? false, // navigating (9)
    appended.problem ?? null, // problem (10)
    appended.submitting ?? null, // submitting (11)
  ];
  stateCursor = 0;
  setters = [];
  return EditPostingForm({
    payerId: PAYER_ID,
    postingId: POSTING_ID,
    status,
    initial: INITIAL,
  }) as ReactElement;
}

async function submit(tree: ReactElement) {
  const form = findForm(tree);
  expect(form).not.toBeNull();
  await form!.props.onSubmit({ preventDefault: () => undefined });
}

beforeEach(() => {
  updatePostingAction.mockReset().mockResolvedValue({ ok: true, posting: SAVED });
  navigate.mockReset();
  draftHook.restored = false;
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
    expect(navigate).toHaveBeenCalledWith(`/postings/${POSTING_ID}`, LANDING);

    updatePostingAction.mockResolvedValue({ ok: false, error: "No changes to save." });
    await submit(render({}));
    expect(setters[5]).toHaveBeenCalledWith("No changes to save.");
  });

  it("a publish that reports its reach lands on the detail with ?reached=N (Reached N workers)", async () => {
    updatePostingAction.mockResolvedValue({ ok: true, posting: SAVED, reached: 42 });
    await submit(render({}));
    expect(navigate).toHaveBeenCalledWith(`/postings/${POSTING_ID}?reached=42`, LANDING);
  });

  it("no reach count (save, or a failed reach read) → the plain detail URL, no number", async () => {
    updatePostingAction.mockResolvedValue({ ok: true, posting: SAVED, reached: null });
    await submit(render({}));
    expect(navigate).toHaveBeenCalledWith(`/postings/${POSTING_ID}`, LANDING);
  });
});

describe("EditPostingForm — what is saved is what the preview showed (readCardForm)", () => {
  it('"21,000" is saved as 21000 (the box was type=number, which turned it into "" → a CLEAR)', async () => {
    await submit(render({ payMin: "21,000", payMax: "30,000" }));
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.payMin).toBe(21000);
    expect(input.payMax).toBe(30000);
  });

  it('"1.5" years BLOCKS the save — sending it as "not stated" would clear the stored value', async () => {
    await submit(render({ minExperienceYears: "1.5", maxExperienceYears: "4" }));
    expect(updatePostingAction).not.toHaveBeenCalled();
    expect(setters[5]).toHaveBeenCalledWith(expect.stringContaining("needs a whole number"));
    // …and the order error is revealed on every number box (index 8 = revealed).
    expect(setters[8]).toHaveBeenCalled();
  });

  it("a requirement typed but not added is SAVED (and shown as added)", async () => {
    await submit(
      render({}, "open", { requirements: ["Fanuc control"], reqDraft: " MIG welding " }),
    );
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.requirements).toEqual(["Fanuc control", "MIG welding"]);
    expect(setters[1]).toHaveBeenCalledWith(["Fanuc control", "MIG welding"]);
    expect(setters[3]).toHaveBeenCalledWith("");
  });

  it("a successful save navigates AND refreshes, so Back never restores the pre-save form", async () => {
    await submit(render({}));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![1]).toMatchObject({ refresh: true });
  });

  it("the shell's cue names the SAVED posting ('Opening <its title>…'), not the form's draft title", async () => {
    updatePostingAction.mockResolvedValue({
      ok: true,
      posting: { ...SAVED, roleTitle: "Senior CNC Machinist" },
    });
    await submit(render({}));
    expect(navigate).toHaveBeenCalledWith(`/postings/${POSTING_ID}`, {
      pendingLabel: "Senior CNC Machinist",
      refresh: true,
    });
  });

  it("the role kind and the openings label are sent through the same read", async () => {
    await submit(render({ roleKind: "welder", vacancies: "1,000" }));
    const input = updatePostingAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.roleKind).toBe("welder");
    expect(input.vacancies).toBe(1000);
  });
});

/** Every DOM-level element in the (function-expanded) tree, in order. */
function hosts(node: ReactNode, out: Array<ReactElement<Record<string, unknown>>> = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) hosts(c, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  // The shared icon-only control (a chip's remove button) is the one HOOKED primitive: record it
  // as the native button it renders, named by its label, instead of calling it outside React.
  if (el.type === IconButtonBase) {
    out.push({
      type: "button",
      props: { "aria-label": el.props.label, onClick: el.props.onClick },
    } as never);
    return out;
  }
  if (typeof el.type === "function")
    return hosts((el.type as (p: unknown) => ReactNode)(el.props), out);
  out.push(el);
  if ("children" in el.props) hosts(el.props.children, out);
  return out;
}
const textOf = (els: Array<ReactElement<Record<string, unknown>>>) =>
  els.map((e) => (typeof e.props.children === "string" ? e.props.children : "")).join(" ");

/** The rail element the form renders (its props carry the primary button). */
function railOf(tree: ReactElement) {
  const layout = tree as ReactElement<{ children: ReactNode[] }>;
  const rail = (layout.props.children as ReactElement[]).find(
    (c) =>
      typeof c?.type === "function" && (c.type as { name?: string }).name === "PostingPreviewRail",
  ) as ReactElement<{ primary: ReactElement<{ onClick?: () => void; disabled?: boolean }> }>;
  expect(rail).toBeDefined();
  return rail;
}

describe("EditPostingForm — a refused save says why AT the field focus moves to (M2)", () => {
  it("a client-side refusal records the control + reason (index 10) as well as the status (5)", async () => {
    await submit(render({ roleTitle: "x" }));
    expect(setters[10]).toHaveBeenCalledWith({
      control: "roleTitle",
      message: "Role title must be at least 2 characters.",
    });
  });

  it("the recorded reason is that control's own error (aria-invalid + the message)", () => {
    const tree = render({ roleTitle: "x" }, "open", {}, undefined, {
      problem: { control: "roleTitle", message: "Role title must be at least 2 characters." },
    });
    const els = hosts(tree);
    const title = els.find((e) => e.props.id === "roleTitle")!;
    expect(title.props["aria-invalid"]).toBe(true);
    expect(els.some((e) => e.props.className === "bb-field__error")).toBe(true);
    // Only that control is marked.
    expect(els.filter((e) => e.props["aria-invalid"] === true).map((e) => e.props.id)).toEqual([
      "roleTitle",
    ]);
  });

  it("PUBLISH refused by the gap rule never calls the action and points at the missing control", async () => {
    const tree = render({}, "draft", {}, { matchSkillIds: ["mskill_x"], untickedRelatedIds: [] });
    railOf(tree).props.primary.props.onClick!();
    await Promise.resolve();
    expect(updatePostingAction).not.toHaveBeenCalled();
    expect(setters[10]).toHaveBeenCalledWith({
      control: "roleKind",
      message: expect.stringContaining("Pick the role"),
    });
    expect(setters[5]).toHaveBeenCalledWith(expect.stringContaining("Pick the role:"));
  });
});

/** ALL the text under a node (nested elements and arrays included; DS components rendered). */
function deepText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(deepText).join("");
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "function")
    return deepText((el.type as (p: unknown) => ReactNode)(el.props));
  return "children" in el.props ? deepText(el.props.children) : "";
}

/** The text of every LIVE region the form draws (`aria-live`, role alert / status). */
function liveTexts(tree: ReactNode): string[] {
  const out: string[] = [];
  for (const el of hosts(tree)) {
    const role = el.props.role;
    if (el.props["aria-live"] !== undefined || role === "alert" || role === "status") {
      out.push(deepText(el.props.children as ReactNode));
    }
  }
  return out;
}

describe("EditPostingForm — M3: a refused save's reason is announced ONCE", () => {
  const REASON = "Role title must be at least 2 characters.";

  it("a refusal a FIELD owns: the field is described by it, and no live region repeats it", () => {
    const tree = render({ roleTitle: "x" }, "open", {}, undefined, {
      error: REASON,
      problem: { control: "roleTitle", message: REASON },
    });
    const els = hosts(tree);
    expect(els.find((e) => e.props.id === "roleTitle")!.props["aria-describedby"]).toBe(
      "roleTitle-msg",
    );
    expect(deepText(els.find((e) => e.props.id === "roleTitle-msg"))).toBe(REASON);
    // Still drawn by the button, twice (rail footer + dock), as well as at the field…
    expect(deepText(tree).split("Your changes were not saved. " + REASON)).toHaveLength(3);
    // …but not announced from there: focus moves to the field, whose description reads it.
    expect(liveTexts(tree).length).toBeGreaterThan(0);
    expect(liveTexts(tree).filter((t) => t.includes(REASON))).toEqual([]);
  });

  it("a refusal no field owns (the server's) IS announced, from the live slots", () => {
    const tree = render({}, "open", {}, undefined, { error: "The posting changed elsewhere." });
    const live = liveTexts(tree).filter((t) => t.includes("The posting changed elsewhere."));
    expect(live).toHaveLength(2); // rail footer + dock — one per breakpoint
  });
});

describe("EditPostingForm — a refusal ENDS when the payer fixes its field (never re-announced)", () => {
  const REASON = "Role title must be at least 2 characters.";
  // Every card field filled, so the form shows no "Still to fill" summary of its own.
  const FULL = {
    roleTitle: "x",
    roleKind: "cnc_turner",
    city: "Pune",
    payMin: "18000",
    payMax: "26000",
    payType: "in_hand",
    minExperienceYears: "1",
    maxExperienceYears: "5",
    shift: "day",
    neededBy: "soon",
    description: "Run two lathes.",
  };
  const CHIPS = { requirements: ["Fanuc"], benefits: ["PF"] };
  const refused = (control: string) => ({ error: REASON, problem: { control, message: REASON } });

  it("editing the flagged field clears the refusal's mark AND its message (index 10 + index 5)", () => {
    const tree = render(FULL, "open", CHIPS, undefined, refused("roleTitle"));
    const box = hosts(tree).find((e) => e.props.id === "roleTitle")!;
    (box.props.onChange as (e: unknown) => void)({ target: { value: "xy" } });
    expect(setters[10]).toHaveBeenCalledWith(null);
    // Without this the message outlives its mark, reads as a refusal no field owns, and falls
    // into the live slot — "Your changes were not saved…" announced again after one keystroke.
    expect(setters[5]).toHaveBeenCalledWith(null);
  });

  it("…so the state it leaves behind announces nothing: every live region is empty", () => {
    const after = render({ ...FULL, roleTitle: "xy" }, "open", CHIPS, undefined, {});
    expect(liveTexts(after).length).toBeGreaterThan(0);
    expect(liveTexts(after).filter((t) => t.trim() !== "")).toEqual([]);
  });

  it("adding a chip to the flagged chip list ends that refusal the same way", () => {
    const tree = render(
      FULL,
      "open",
      { requirements: [], benefits: ["PF"], reqDraft: "Fanuc" },
      undefined,
      refused("requirements"),
    );
    const editor = hosts(tree).find((e) => e.props.id === "requirements")!;
    (editor.props.onKeyDown as (e: unknown) => void)({
      key: "Enter",
      preventDefault: () => undefined,
    });
    expect(setters[10]).toHaveBeenCalledWith(null);
    expect(setters[5]).toHaveBeenCalledWith(null);
  });

  it("editing ANOTHER field leaves the refusal (mark and message) in place", () => {
    const tree = render(FULL, "open", CHIPS, undefined, refused("roleTitle"));
    const city = hosts(tree).find((e) => e.props.id === "city")!;
    (city.props.onChange as (e: unknown) => void)({ target: { value: "Nashik" } });
    expect(setters[10]).not.toHaveBeenCalled();
    expect(setters[5]).not.toHaveBeenCalled();
  });
});

describe("EditPostingForm — owner naming ruling: Publish posting / Publishing…", () => {
  const SEL = { matchSkillIds: ["mskill_x"], untickedRelatedIds: [] };
  const publishText = (tree: ReactElement) =>
    textOf(hosts(railOf(tree).props.primary as unknown as ReactNode));

  it("a draft's primary reads 'Publish posting'", () => {
    expect(publishText(render({}, "draft", {}, SEL))).toContain("Publish posting");
  });

  it("while ITS request is in flight it reads 'Publishing…' — a draft save in flight does not", () => {
    expect(
      publishText(render({}, "draft", {}, SEL, { navigating: true, submitting: "publish" })),
    ).toContain("Publishing…");
    const saving = publishText(
      render({}, "draft", {}, SEL, { navigating: true, submitting: "save" }),
    );
    expect(saving).toContain("Publish posting");
    expect(saving).not.toContain("Publishing…");
  });

  it("a publish that passes the client checks records which button is in flight (index 11)", async () => {
    const tree = render(
      {
        roleKind: "cnc_turner",
        city: "Pune",
        payMin: "18000",
        payMax: "26000",
        payType: "in_hand",
        minExperienceYears: "1",
        maxExperienceYears: "5",
        shift: "day",
        neededBy: "soon",
        description: "Run two lathes.",
      },
      "draft",
      { requirements: ["Fanuc"], benefits: ["PF"] },
      SEL,
    );
    railOf(tree).props.primary.props.onClick!();
    await Promise.resolve();
    expect(setters[11]).toHaveBeenCalledWith("publish");
  });
});

describe("EditPostingForm — the navigating latch (I2: no double save during the remount)", () => {
  it("a successful save latches navigating (index 9) before navigating", async () => {
    await submit(render({}));
    expect(setters[9]).toHaveBeenCalledWith(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("while navigating, every save/publish button is disabled", () => {
    const tree = render(
      {},
      "draft",
      {},
      { matchSkillIds: ["mskill_x"], untickedRelatedIds: [] },
      { navigating: true },
    );
    const buttons = hosts(tree).filter((e) => e.type === "button");
    const actionButtons = buttons.filter((b) =>
      /Save|Publish/.test(textOf(hosts(b.props.children as ReactNode))),
    );
    expect(actionButtons.length).toBeGreaterThan(0);
    expect(actionButtons.every((b) => b.props.disabled === true)).toBe(true);
  });
});

describe("EditPostingForm — owner naming ruling: the entity is a 'posting' (F36)", () => {
  it("the description hint says 'open the posting', never 'job'", () => {
    const hint = hosts(render({})).find((e) => e.props.id === "description-msg");
    expect(hint).toBeDefined();
    expect(deepText(hint!)).toContain("Workers read this when they open the posting.");
    expect(deepText(hint!)).not.toMatch(/\bjob\b/i);
  });
});

/* ── W4 (#2584) ─────────────────────────────────────────────────────────────────── */

describe("EditPostingForm — W4: one spinner per action", () => {
  const SEL = { matchSkillIds: ["mskill_x"], untickedRelatedIds: [] };
  /** The text of every busy (spinning) button in the rail's actions — one copy of the buttons. */
  const spinning = (tree: ReactElement) =>
    hosts((railOf(tree).props as unknown as { actions: ReactNode }).actions)
      .filter((e) => e.type === "button" && e.props["aria-busy"] === true)
      .map((b) => textOf(hosts(b.props.children as ReactNode)).trim());

  it("a draft SAVE in flight spins Save draft only; Publish is just disabled", () => {
    const tree = render({}, "draft", {}, SEL, { navigating: true, submitting: "save" });
    expect(spinning(tree)).toEqual(["Save draft"]);
  });

  it("a PUBLISH in flight spins Publish only", () => {
    const tree = render({}, "draft", {}, SEL, { navigating: true, submitting: "publish" });
    expect(spinning(tree)).toEqual(["Publishing…"]);
  });

  it("a successful save drops the local draft", async () => {
    discardDraft.mockClear();
    await submit(render({}));
    expect(discardDraft).toHaveBeenCalledTimes(1);
  });

  it("the draft is kept under the signed-in payer's own key for this posting", () => {
    render({});
    expect(draftHook.storageKey).toBe(`bb:posting-draft:${PAYER_ID}:edit:${POSTING_ID}`);
  });

  it("no restored draft, no 'Restored' line", () => {
    expect(hosts(render({})).some((e) => e.props.className === "mw-draft-restored")).toBe(false);
  });

  it("a restored draft is said, and Discard drops it and reseeds the saved posting", () => {
    draftHook.restored = true;
    discardDraft.mockClear();
    const tree = render({ payMin: "18000" }, "open", { requirements: ["ITI"] });
    const notice = hosts(tree).find((e) => e.props.className === "mw-draft-restored")!;
    expect(notice.props.role).toBe("status");
    expect(textOf(hosts(notice))).toContain("Restored unsaved changes from this device");
    const discard = hosts(notice).find((e) => e.type === "button")!;
    expect(textOf(hosts(discard.props.children as ReactNode)).trim()).toBe("Discard");

    (discard.props.onClick as () => void)();
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(setters[0]).toHaveBeenCalledWith(BLANK_FIELDS); // fields — the saved posting's
    expect(setters[1]).toHaveBeenCalledWith([]); // requirements
    expect(setters[6]).toHaveBeenCalledWith({
      tradeLevel: "",
      answers: {},
      matchSkillIds: [],
      dirty: false,
    });
    expect(setters[13]).toHaveBeenCalledWith({ matchSkillIds: [], untickedRelatedIds: [] });
  });
});

describe("isEditPostingDirty — what makes leaving an edit ask first (W4)", () => {
  const SEEDED = {
    fields: BLANK_FIELDS,
    requirements: [] as string[],
    benefits: [] as string[],
    reqDraft: "",
    benDraft: "",
    trade: { tradeLevel: "", answers: {}, matchSkillIds: [] as string[], dirty: false },
    legacySelection: { matchSkillIds: [] as string[], untickedRelatedIds: [] as string[] },
  };

  it("the form exactly as seeded is clean", async () => {
    const { isEditPostingDirty } = await import("./edit-posting-form");
    expect(isEditPostingDirty(SEEDED, INITIAL, undefined)).toBe(false);
  });

  it("a changed field, chip, chip draft or trade pick is dirty", async () => {
    const { isEditPostingDirty } = await import("./edit-posting-form");
    expect(
      isEditPostingDirty(
        { ...SEEDED, fields: { ...BLANK_FIELDS, city: "Pune" } },
        INITIAL,
        undefined,
      ),
    ).toBe(true);
    expect(isEditPostingDirty({ ...SEEDED, requirements: ["ITI"] }, INITIAL, undefined)).toBe(true);
    expect(isEditPostingDirty({ ...SEEDED, reqDraft: "ITI" }, INITIAL, undefined)).toBe(true);
    expect(
      isEditPostingDirty(
        { ...SEEDED, trade: { ...SEEDED.trade, dirty: true } },
        INITIAL,
        undefined,
      ),
    ).toBe(true);
  });
});
