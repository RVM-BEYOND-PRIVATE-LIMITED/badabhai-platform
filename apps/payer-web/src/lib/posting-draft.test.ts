import { describe, expect, it, vi } from "vitest";
import {
  LEAVE_CONFIRM,
  clearAllPostingDrafts,
  clearDraft,
  installLeaveGuard,
  leavingHref,
  loadDraft,
  postingDraftKey,
  saveDraft,
  type GuardedClick,
} from "./posting-draft";

/**
 * W4 (#2584) — the posting forms' local draft and leave guard. Acceptance: "Leaving a dirty form
 * asks first." Node env: storage, window and document are hand-made stand-ins.
 */

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

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";

describe("the draft store", () => {
  it("keys a new posting and each edit apart", () => {
    expect(postingDraftKey({ kind: "new", payerId: PAYER_A })).not.toBe(
      postingDraftKey({ kind: "edit", payerId: PAYER_A, postingId: "p1" }),
    );
    expect(postingDraftKey({ kind: "edit", payerId: PAYER_A, postingId: "p1" })).not.toBe(
      postingDraftKey({ kind: "edit", payerId: PAYER_A, postingId: "p2" }),
    );
  });

  it("keys every draft by the signed-in payer — company B never reads company A's", () => {
    expect(postingDraftKey({ kind: "new", payerId: PAYER_A })).toBe(
      `bb:posting-draft:${PAYER_A}:new`,
    );
    expect(postingDraftKey({ kind: "edit", payerId: PAYER_A, postingId: "p1" })).toBe(
      `bb:posting-draft:${PAYER_A}:edit:p1`,
    );
    expect(postingDraftKey({ kind: "new", payerId: PAYER_A })).not.toBe(
      postingDraftKey({ kind: "new", payerId: PAYER_B }),
    );
    expect(postingDraftKey({ kind: "edit", payerId: PAYER_A, postingId: "p1" })).not.toBe(
      postingDraftKey({ kind: "edit", payerId: PAYER_B, postingId: "p1" }),
    );

    const store = memoryStore();
    saveDraft(postingDraftKey({ kind: "new", payerId: PAYER_A }), "new", { city: "Pune" }, store);
    expect(loadDraft(postingDraftKey({ kind: "new", payerId: PAYER_B }), "new", store)).toBeNull();
  });

  it("sign-out's sweep removes every payer's posting drafts and nothing else", () => {
    const store = memoryStore();
    saveDraft(postingDraftKey({ kind: "new", payerId: PAYER_A }), "new", { city: "Pune" }, store);
    saveDraft(postingDraftKey({ kind: "edit", payerId: PAYER_A, postingId: "p1" }), "b", {}, store);
    saveDraft(postingDraftKey({ kind: "new", payerId: PAYER_B }), "new", { city: "Nashik" }, store);
    store.setItem("bb:theme", "dark");

    clearAllPostingDrafts(store);

    expect(store.length).toBe(1);
    expect(store.getItem("bb:theme")).toBe("dark");
    // Blocked or missing storage is a no-op, never an error.
    const blocked = {
      get length(): number {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(() => clearAllPostingDrafts(blocked)).not.toThrow();
    expect(() => clearAllPostingDrafts(undefined)).not.toThrow();
  });

  it("a saved draft comes back from the same base", () => {
    const store = memoryStore();
    expect(saveDraft("k", "base-1", { title: "CNC" }, store)).toBe(true);
    expect(loadDraft("k", "base-1", store)).toEqual({ title: "CNC" });
  });

  it("a draft taken from another base (the posting was saved since) is dropped, never restored", () => {
    const store = memoryStore();
    saveDraft("k", "base-1", { title: "old" }, store);
    expect(loadDraft("k", "base-2", store)).toBeNull();
    expect(store.getItem("k")).toBeNull();
  });

  it("clear removes it; broken or blocked storage reads as no draft, never an error", () => {
    const store = memoryStore();
    saveDraft("k", "b", { a: 1 }, store);
    clearDraft("k", store);
    expect(loadDraft("k", "b", store)).toBeNull();

    store.setItem("k", "{not json");
    expect(loadDraft("k", "b", store)).toBeNull();

    const blocked = {
      ...memoryStore(),
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    } as Storage;
    expect(saveDraft("k", "b", {}, blocked)).toBe(false);
    expect(loadDraft("k", "b", blocked)).toBeNull();
    expect(saveDraft("k", "b", {}, undefined)).toBe(false);
  });
});

const HERE = { origin: "https://payer.example", pathname: "/postings/new", search: "" };

function anchor(attrs: Record<string, string>) {
  const a = {
    getAttribute: (n: string) => attrs[n] ?? null,
    hasAttribute: (n: string) => n in attrs,
  };
  return { closest: (sel: string) => (sel === "a[href]" && "href" in attrs ? a : null) };
}

function click(attrs: Record<string, string>, over: Partial<GuardedClick> = {}): GuardedClick {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: anchor(attrs) as unknown as EventTarget,
    ...over,
  };
}

describe("leavingHref — which clicks leave the form", () => {
  it("an in-app link to another page leaves", () => {
    expect(leavingHref(click({ href: "/postings" }), HERE)).toBe("/postings");
    expect(leavingHref(click({ href: "/postings?tab=open" }), HERE)).toBe("/postings?tab=open");
  });

  it("a new tab, a download, another site, a fragment or a modified click does not", () => {
    expect(leavingHref(click({ href: "/postings", target: "_blank" }), HERE)).toBeNull();
    expect(leavingHref(click({ href: "/x.pdf", download: "" }), HERE)).toBeNull();
    expect(leavingHref(click({ href: "https://elsewhere.example/" }), HERE)).toBeNull();
    expect(leavingHref(click({ href: "#match-skills" }), HERE)).toBeNull();
    expect(leavingHref(click({ href: "/postings" }, { metaKey: true }), HERE)).toBeNull();
    expect(leavingHref(click({ href: "/postings" }, { button: 1 }), HERE)).toBeNull();
    expect(leavingHref(click({ href: "/postings" }, { defaultPrevented: true }), HERE)).toBeNull();
    expect(leavingHref(click({}), HERE)).toBeNull();
  });
});

/** A window/document pair that records listeners, so a test can fire them. */
function fakeWindow() {
  const winListeners = new Map<string, (e: unknown) => void>();
  const docListeners = new Map<string, { fn: (e: unknown) => void; capture: unknown }>();
  const win = {
    location: HERE,
    addEventListener: (t: string, fn: (e: unknown) => void) => winListeners.set(t, fn),
    removeEventListener: (t: string) => winListeners.delete(t),
    document: {
      addEventListener: (t: string, fn: (e: unknown) => void, capture: unknown) =>
        docListeners.set(t, { fn, capture }),
      removeEventListener: (t: string) => docListeners.delete(t),
    },
  };
  return { win: win as unknown as Window, winListeners, docListeners };
}

function linkClick(href = "/postings") {
  return {
    ...click({ href }),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("installLeaveGuard — leaving a dirty form asks first", () => {
  it("a dirty form: an in-app link asks; 'stay' stops the navigation before the router sees it", () => {
    const { win, docListeners } = fakeWindow();
    const confirmLeave = vi.fn(() => false);
    installLeaveGuard(() => true, confirmLeave, win);
    const listener = docListeners.get("click")!;
    expect(listener.capture).toBe(true); // capture phase: ahead of the link's own handler
    const e = linkClick();
    listener.fn(e);
    expect(confirmLeave).toHaveBeenCalledWith(LEAVE_CONFIRM);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("'leave' lets the link go on", () => {
    const { win, docListeners } = fakeWindow();
    installLeaveGuard(
      () => true,
      () => true,
      win,
    );
    const e = linkClick();
    docListeners.get("click")!.fn(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it("a clean form never asks", () => {
    const { win, docListeners, winListeners } = fakeWindow();
    const confirmLeave = vi.fn(() => false);
    installLeaveGuard(() => false, confirmLeave, win);
    const e = linkClick();
    docListeners.get("click")!.fn(e);
    expect(confirmLeave).not.toHaveBeenCalled();
    const unload = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    winListeners.get("beforeunload")!(unload);
    expect(unload.preventDefault).not.toHaveBeenCalled();
  });

  it("a dirty form: closing the tab or reloading raises the browser's own prompt", () => {
    const { win, winListeners } = fakeWindow();
    installLeaveGuard(
      () => true,
      () => false,
      win,
    );
    const unload = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    winListeners.get("beforeunload")!(unload);
    expect(unload.preventDefault).toHaveBeenCalled();
    expect(unload.returnValue).toBe("");
  });

  it("the cleanup removes both listeners", () => {
    const { win, winListeners, docListeners } = fakeWindow();
    const off = installLeaveGuard(
      () => true,
      () => false,
      win,
    );
    off();
    expect(winListeners.size).toBe(0);
    expect(docListeners.size).toBe(0);
  });
});
