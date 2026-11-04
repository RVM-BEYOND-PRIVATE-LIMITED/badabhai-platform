import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";

/**
 * W4 (#2584) — `usePostingDraft`, the hook that ties the draft store (lib/posting-draft.ts, whose
 * rules have their own suite) to a posting form's lifecycle.
 *
 * The node env cannot mount React, so `useState` / `useRef` / `useEffect` are a small runtime: one
 * slot per call, in call order; after each render the effects whose deps changed are committed as
 * React commits them (every cleanup first, then every effect, in order). Storage is an in-memory
 * stand-in on a stubbed `window`; timers are faked.
 */

type Effect = () => void | (() => void);
const runtime = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps: readonly unknown[] | undefined; cleanup: void | (() => void) }>,
  queue: [] as Array<{ i: number; run: Effect; deps: readonly unknown[] | undefined }>,
  cursor: { state: 0, ref: 0, effect: 0 },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useState: (initial: unknown) => {
    const i = runtime.cursor.state++;
    if (!(i in runtime.states)) runtime.states[i] = initial;
    const set = (next: unknown) => {
      runtime.states[i] =
        typeof next === "function" ? (next as (prev: unknown) => unknown)(runtime.states[i]) : next;
    };
    return [runtime.states[i], set];
  },
  useRef: (initial: unknown) => {
    const i = runtime.cursor.ref++;
    runtime.refs[i] ??= { current: initial };
    return runtime.refs[i];
  },
  useEffect: (run: Effect, deps?: readonly unknown[]) => {
    const i = runtime.cursor.effect++;
    const prev = runtime.effects[i];
    const changed =
      prev === undefined ||
      deps === undefined ||
      prev.deps === undefined ||
      deps.length !== prev.deps.length ||
      deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (changed) runtime.queue.push({ i, run, deps });
  },
}));

function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

const store = memoryStore();
vi.stubGlobal("window", {
  localStorage: store,
  location: { origin: "https://payer.example", pathname: "/postings/new", search: "" },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  confirm: () => true,
  document: { addEventListener: () => undefined, removeEventListener: () => undefined },
});

const { usePostingDraft } = await import("./use-posting-draft");
const { postingDraftKey, saveDraft } = await import("../lib/posting-draft");

const KEY = postingDraftKey({
  kind: "edit",
  payerId: "11111111-1111-4111-8111-111111111111",
  postingId: "p1",
});
const BASE = "revision-1";
const SAVE_AFTER_MS = 600;

interface Form {
  payMin: string;
  /** A pick from a control the form no longer has: kept in a stored draft, never part of `dirty`. */
  oldPick?: string[];
}
/** The live posting's value — the form's seed. */
const SEED: Form = { payMin: "15000" };
const EDITED: Form = { payMin: "18000" };
/** The form's "differs from the seed" — its `dirty`, and the `isDirty` it may pass for a draft. */
const differsFromSeed = (form: Form) => form.payMin !== SEED.payMin;

const stored = () => store.getItem(KEY);

function mount() {
  runtime.states = [];
  runtime.refs = [];
  runtime.effects = [];
}

/**
 * One render of the hook, then its commit. `dirty` is the form's own "differs from the seed";
 * `isDirty`, when given, is the same test passed for a stored draft.
 */
function render(
  payload: Form,
  onRestore: (p: Form) => void = () => undefined,
  isDirty?: (p: Form) => boolean,
) {
  runtime.cursor = { state: 0, ref: 0, effect: 0 };
  runtime.queue = [];
  const out = usePostingDraft<Form>({
    storageKey: KEY,
    base: BASE,
    payload,
    dirty: differsFromSeed(payload),
    ...(isDirty !== undefined ? { isDirty } : {}),
    off: false,
    onRestore,
  });
  const commit = runtime.queue;
  for (const { i } of commit) {
    const cleanup = runtime.effects[i]?.cleanup;
    if (typeof cleanup === "function") cleanup();
  }
  for (const { i, run, deps } of commit) runtime.effects[i] = { deps, cleanup: run() };
  return out;
}

function unmount() {
  for (const effect of runtime.effects) {
    if (typeof effect?.cleanup === "function") effect.cleanup();
  }
  runtime.effects = [];
}

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
});
afterEach(() => vi.useRealTimers());

describe("usePostingDraft — a form back at its seed keeps no draft", () => {
  it("an edit typed, saved, then undone by hand removes the draft; the next visit restores nothing", () => {
    mount();
    render(SEED);
    render(EDITED);
    vi.advanceTimersByTime(SAVE_AFTER_MS);
    expect(JSON.parse(stored()!).payload).toEqual(EDITED);
    expect(render(EDITED).saved).toBe(true);

    // 18000 back to 15000: the form matches the live posting again.
    render(SEED);
    expect(stored()).toBeNull();
    unmount();

    // Reopening Edit shows the live posting — the undone 18000 does not come back.
    const onRestore = vi.fn();
    mount();
    render(SEED, onRestore);
    expect(onRestore).not.toHaveBeenCalled();
    expect(render(SEED, onRestore).restored).toBe(false);
    unmount();
  });

  it("the mount pass never wipes the draft it is restoring (it runs before that state lands)", () => {
    saveDraft(KEY, BASE, EDITED);
    const onRestore = vi.fn();
    mount();
    render(SEED, onRestore);
    expect(onRestore).toHaveBeenCalledWith(EDITED);
    expect(stored()).not.toBeNull();

    // The restored state lands: the form is dirty, the draft stays, and the form says so.
    const out = render(EDITED, onRestore);
    expect(out.restored).toBe(true);
    expect(stored()).not.toBeNull();
    expect(onRestore).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("restored changes the payer reverts by hand drop the draft and the 'Restored' line", () => {
    saveDraft(KEY, BASE, EDITED);
    mount();
    render(SEED, () => undefined);
    expect(render(EDITED).restored).toBe(true);

    render(SEED);
    expect(stored()).toBeNull();
    expect(render(SEED).restored).toBe(false);
    unmount();
  });
});

describe("usePostingDraft — a stored draft that changes nothing is dropped, not restored", () => {
  /** A draft whose one difference from the seed is a pick no control shows or sends any more. */
  const OLD_PICK_ONLY: Form = { ...SEED, oldPick: ["mskill_delivery_rider"] };

  it("is removed from the device: no onRestore, no 'Restored' line, nothing for the next visit", () => {
    saveDraft(KEY, BASE, OLD_PICK_ONLY);
    const onRestore = vi.fn();
    mount();
    render(SEED, onRestore, differsFromSeed);
    expect(onRestore).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(render(SEED, onRestore, differsFromSeed).restored).toBe(false);
    unmount();

    mount();
    render(SEED, onRestore, differsFromSeed);
    expect(onRestore).not.toHaveBeenCalled();
    unmount();
  });

  it("a draft that does change the form is restored, as before", () => {
    saveDraft(KEY, BASE, EDITED);
    const onRestore = vi.fn();
    mount();
    render(SEED, onRestore, differsFromSeed);
    expect(onRestore).toHaveBeenCalledWith(EDITED);
    expect(render(EDITED, onRestore, differsFromSeed).restored).toBe(true);
    expect(stored()).not.toBeNull();
    unmount();
  });

  it("without `isDirty`, every draft from the same base is restored, as before (the option is additive)", () => {
    saveDraft(KEY, BASE, OLD_PICK_ONLY);
    const onRestore = vi.fn();
    mount();
    render(SEED, onRestore);
    expect(onRestore).toHaveBeenCalledWith(OLD_PICK_ONLY);
    unmount();
  });
});

describe("usePostingDraft — Discard", () => {
  it("drops the draft, stops a save still waiting out the pause, and ends the 'Restored' line", () => {
    saveDraft(KEY, BASE, EDITED);
    mount();
    render(SEED, () => undefined);
    const out = render(EDITED); // restored — and a save of it is now waiting
    expect(out.restored).toBe(true);

    out.discard();
    expect(stored()).toBeNull();
    vi.advanceTimersByTime(SAVE_AFTER_MS * 2);
    expect(stored()).toBeNull();

    // The form reseeds itself: nothing restored, nothing stored.
    expect(render(SEED).restored).toBe(false);
    expect(stored()).toBeNull();
    unmount();

    const onRestore = vi.fn();
    mount();
    render(SEED, onRestore);
    expect(onRestore).not.toHaveBeenCalled();
    unmount();
  });
});
