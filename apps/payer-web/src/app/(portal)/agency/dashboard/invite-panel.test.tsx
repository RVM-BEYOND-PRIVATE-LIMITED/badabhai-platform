import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * AGENCY-INVITE-PANEL tests — INLINE PII screen (C11) + A11Y-OF-FAILURE (B8).
 *
 * C11: a phone-like / email-like campaign tag is rejected INLINE (PHONE_OR_EMAIL) BEFORE the
 * Server Action is called; an empty tag is allowed (optional); a clean tag proceeds. The
 * inline error names the field, never echoes the offending content.
 * B8: the invite error region is wrapped in `aria-live="polite"`.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * campaign, campaignError, invite, copied, error). `useTransition` → [false, run-immediately].
 * The submit handler reads the injected `campaign` state, so a phone-like seed exercises the
 * inline reject path with the action mocked.
 *
 * DS3.1 re-skin: the field + buttons + opaque-code result use DS primitives, but the mint
 * `<form onSubmit>` and the `aria-live="polite"` error region stay NATIVE elements — so the
 * walk still finds the form and the announce region. The only input remains the optional,
 * non-PII campaign tag (faceless: still NO phone/name/email/contact field).
 */

const createInviteAction = vi.fn();
vi.mock("./invite-actions", () => ({ createInviteAction: (i: unknown) => createInviteAction(i) }));

let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => useTransition(),
  };
});

const { AgencyInvitePanel } = await import("./invite-panel");

interface Collected {
  forms: Array<{ onSubmit?: (e: { preventDefault: () => void }) => void }>;
  ariaLiveCount: number;
  props: Array<Record<string, unknown>>;
  /** Rendered text nodes — so what an agent READS can be asserted, not just what is wired. */
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.type === "form") {
    acc.forms.push({
      onSubmit: el.props.onSubmit as ((e: { preventDefault: () => void }) => void) | undefined,
    });
  }
  acc.props.push(el.props);
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { forms: [], ariaLiveCount: 0, props: [], text: [] };
  walk(tree, acc);
  return acc;
}

function render(campaign: string) {
  // useState order: campaign, campaignError, invite, copied, error, then the W1 metadata
  // (medium, role, city, contextError) which was APPENDED so these seeds keep their meaning.
  stateQueue = [campaign, null, null, false, null];
  stateCursor = 0;
  return AgencyInvitePanel() as ReactElement;
}

/** Seed the full state vector — needed once a MINTED invite has to be on screen. */
function renderState(seed: unknown[]) {
  stateQueue = seed;
  stateCursor = 0;
  return AgencyInvitePanel() as ReactElement;
}

const MINTED = { code: "abc123def456", link: "/i/abc123def456" };

/** [campaign, campaignError, invite, copied, error, medium, role, city, contextError] */
const mintedState = (over: Partial<Record<number, unknown>> = {}): unknown[] => {
  const base: unknown[] = ["", null, MINTED, false, null, "", "", "", null];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
  return base;
};

function submit(tree: ReactElement) {
  const { forms } = collect(tree);
  expect(forms[0]?.onSubmit).toBeDefined();
  forms[0]!.onSubmit!({ preventDefault: () => {} });
}

beforeEach(() => {
  createInviteAction.mockReset().mockResolvedValue({ ok: true, code: "abc123", link: "/i/abc123" });
  useState.mockClear();
  useTransition.mockClear();
});

describe("AgencyInvitePanel — INLINE PII screen rejects a phone/email tag before the action (C11)", () => {
  it("a phone-like campaign tag is rejected inline; the action is NEVER called", () => {
    submit(render("call +91 98123 45678"));
    expect(createInviteAction).not.toHaveBeenCalled();
  });

  it("an email-like campaign tag is rejected inline; the action is NEVER called", () => {
    submit(render("ping ramesh@example.com"));
    expect(createInviteAction).not.toHaveBeenCalled();
  });

  it("a clean (non-PII) campaign tag proceeds to the action", () => {
    submit(render("diwali-drive"));
    expect(createInviteAction).toHaveBeenCalledWith({ campaign: "diwali-drive" });
  });

  it("an empty tag is allowed (optional) and proceeds with campaign: undefined", () => {
    submit(render(""));
    expect(createInviteAction).toHaveBeenCalledWith({ campaign: undefined });
  });
});

describe("AgencyInvitePanel — an invalid tag is EXPLAINED, not silently blocked", () => {
  it("keeps the submit reachable so `handleCreate` can set the reason under the field", () => {
    // Disabling the submit while `tagError(campaign) !== null` also suppressed Enter, so
    // handleCreate never ran, `campaignError` was never set, and the message under the field
    // — the only thing that says WHY — was unreachable. The button just greyed out.
    const submitBtn = collect(render("call +91 98123 45678")).props.find(
      (p) => p.type === "submit",
    );
    expect(submitBtn).toBeDefined();
    expect(submitBtn!.disabled).toBeFalsy();
  });
});

describe("AgencyInvitePanel — A11Y-OF-FAILURE: error region is aria-live='polite' (B8)", () => {
  it("wraps the invite error in an aria-live='polite' region", () => {
    const { ariaLiveCount } = collect(render(""));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });
});

describe("AgencyInvitePanel — the shared link is ABSOLUTE, not the raw mint path", () => {
  // The mint returns "/i/<code>". Without a configured site url and with no `window` in
  // this env, nothing could be absolutised — so the env supplies the canonical host, which
  // is exactly what a deployed portal does.
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.badabhai.in"));
  afterEach(() => vi.unstubAllEnvs());

  const ABSOLUTE = "https://app.badabhai.in/i/abc123def456";

  it("COPIES the absolute url — pasting into WhatsApp used to send a dead path", async () => {
    // THE REGRESSION PIN for the headline defect: `copy(invite.link)` put "/i/abc123def456"
    // on the clipboard, which resolves to nothing outside a tab already on the portal.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { props } = collect(renderState(mintedState()));
    const copyBtn = props.find(
      (p) => typeof p.onClick === "function" && p.children === "Copy link",
    );
    expect(copyBtn).toBeDefined();
    await (copyBtn!.onClick as () => Promise<void>)();

    expect(writeText).toHaveBeenCalledWith(ABSOLUTE);
    vi.unstubAllGlobals();
  });

  it("SHOWS the same absolute url it copies", () => {
    // What an agent reads off the screen and types by hand must be what the button copies.
    const { text } = collect(renderState(mintedState()));
    expect(text).toContain(ABSOLUTE);
    expect(text).not.toContain(MINTED.link);
  });

  it("offers a WhatsApp share carrying that url, opened safely", () => {
    const { props } = collect(renderState(mintedState()));
    const share = props.find(
      (p) => typeof p.href === "string" && p.href.startsWith("https://wa.me/"),
    );
    expect(share).toBeDefined();
    const url = new URL(share!.href as string);
    // Contact-picker form — no number in the path.
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("text")).toContain(ABSOLUTE);
    expect(share!.target).toBe("_blank");
    expect(String(share!.rel)).toContain("noopener");
    expect(String(share!.rel)).toContain("noreferrer");
  });
});

describe("AgencyInvitePanel — W1 link metadata reaches the action", () => {
  it("forwards the selected medium and the role/city context", () => {
    submit(renderState(mintedState({ 5: "paid", 6: "welder", 7: "pune-west" })));
    expect(createInviteAction).toHaveBeenCalledWith({
      campaign: undefined,
      medium: "paid",
      context: { role: "welder", city: "pune-west" },
    });
  });

  it("sends NO context at all when both slugs are blank", () => {
    submit(renderState(mintedState()));
    expect(createInviteAction).toHaveBeenCalledWith({
      campaign: undefined,
      medium: undefined,
      context: undefined,
    });
  });

  it("rejects a person's name typed into the role slug, INLINE — no mint", () => {
    submit(renderState(mintedState({ 6: "Ramesh Kumar" })));
    expect(createInviteAction).not.toHaveBeenCalled();
  });

  it("rejects a phone typed into the city slug, INLINE — no mint", () => {
    submit(renderState(mintedState({ 7: "+91 98123 45678" })));
    expect(createInviteAction).not.toHaveBeenCalled();
  });

  it("still has NO tel/email/file input and no textarea (faceless)", () => {
    const { props } = collect(render(""));
    const inputTypes = props.map((p) => p.type).filter((t): t is string => typeof t === "string");
    for (const forbidden of ["tel", "email", "file"]) expect(inputTypes).not.toContain(forbidden);
    const placeholders = props
      .map((p) => p.placeholder)
      .filter((p): p is string => typeof p === "string");
    for (const p of placeholders) expect(p).not.toMatch(/phone|mobile|name|email|csv/i);
  });
});
