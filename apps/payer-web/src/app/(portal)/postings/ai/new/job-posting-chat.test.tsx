import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type {
  JobPostingChatSessionSummary,
  JobPostingDraft,
} from "../../../../../lib/contracts";

/**
 * AI JOB-POSTING CHAT UI tests (ADR-0035).
 *
 * Env is node (no DOM), so — following the existing payer-web convention
 * (postings-manager.test.tsx / posting-form.test.tsx) — React state is INJECTED via a
 * `useState` mock, the component function is rendered to an element tree, and the walker
 * renders each hookless DS primitive one level deep to reach its native host.
 *
 * What is pinned here:
 *  1. CROSS-DEVICE PICKUP: an in-progress session renders "Continue where you left off"
 *     instead of a blank chat, and Continue calls the resume action with ONLY the session
 *     id (XB-A — the client never passes a payer id).
 *  2. The chat renders the transcript, the DETERMINISTIC engine's suggested-answer chips,
 *     and the live structured draft (banded vacancies, never a raw count).
 *  3. PUBLISH is gated on the ENGINE's `draftReady`, sends only the session id, and routes
 *     to the posting's EXISTING detail page (`/postings/:id`).
 *  4. RULE A: nothing in this UI asks for the payer's company/org name.
 *  5. The inline turn screen mirrors the manual form's `looksLikePii` description check.
 */

const startJobPostingChatAction = vi.fn();
const sendJobPostingChatMessageAction = vi.fn();
const resumeJobPostingChatAction = vi.fn();
const publishJobPostingChatAction = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
// The walker calls every function component, and the pending cue (inside every PortalLink) runs
// effects — a real hook outside a render. It draws nothing while idle, so it renders nothing here.
vi.mock("../../../../../components/nav-pending", () => ({ NavPendingCue: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("./actions", () => ({
  startJobPostingChatAction: () => startJobPostingChatAction(),
  sendJobPostingChatMessageAction: (i: unknown) => sendJobPostingChatMessageAction(i),
  resumeJobPostingChatAction: (i: unknown) => resumeJobPostingChatAction(i),
  publishJobPostingChatAction: (i: unknown) => publishJobPostingChatAction(i),
}));

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

const { JobPostingChat, validateTurn } = await import("./job-posting-chat");

/* ── fixtures ───────────────────────────────────────────────────────────────────── */

const SESSION_ID = "aaaa1111-0000-4000-8000-000000000001";
const POSTING_ID = "bbbb2222-0000-4000-8000-000000000002";

const RESUMABLE: JobPostingChatSessionSummary = {
  sessionId: SESSION_ID,
  status: "active",
  draftReady: false,
  roleTitle: "CNC Machinist",
  city: "Pune",
  startedAt: "2026-07-20T00:00:00.000Z",
  lastMessageAt: "2026-07-26T09:00:00.000Z",
  publishedJobPostingId: null,
};

const DRAFT: JobPostingDraft = {
  roleTitle: "CNC Machinist",
  tradeKey: "cnc_operator",
  skillPhrases: ["vmc", "fanuc"],
  locationLabel: "Pune, MH",
  vacancyBand: "6-10",
  payMin: 20000,
  payMax: 35000,
  shift: "night",
  benefits: ["PF"],
  requirements: ["ITI"],
  description: "Two-shift CNC role.",
  city: "Pune",
  payType: "in_hand",
  minExperienceYears: 2,
  maxExperienceYears: 6,
  neededBy: "immediate",
  confidence: 0.8,
  missingFields: [],
  clarificationQuestions: [],
};

interface Convo {
  sessionId: string;
  lines: Array<{ role: "payer" | "assistant"; text: string }>;
  draft: JobPostingDraft | null;
  draftReady: boolean;
  suggestions: string[];
}

const CONVO: Convo = {
  sessionId: SESSION_ID,
  lines: [
    { role: "assistant", text: "What role are you hiring for?" },
    { role: "payer", text: "CNC operators" },
  ],
  draft: DRAFT,
  draftReady: false,
  suggestions: ["Just 1", "2-5", "6-10"],
};

/* ── walker ─────────────────────────────────────────────────────────────────────── */

interface Collected {
  buttons: Array<{ text: string; disabled: boolean; className: string; onClick?: () => void }>;
  texts: string[];
  /** Every native form host rendered (id + tag), to prove which fields exist at all. */
  fields: Array<{ tag: string; id?: string }>;
  ariaLiveCount: number;
  /** Every anchor rendered (the mocked next/link renders a native `a`). */
  links: Array<{ href: string; text: string }>;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") {
    const fn = el.type as (props: unknown) => ReactNode;
    return textOf(fn(el.props));
  }
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "function") {
    const fn = el.type as (props: unknown) => ReactNode;
    walk(fn(el.props), acc);
    return;
  }
  if (el.type === "button") {
    acc.buttons.push({
      text: textOf(el.props.children).trim(),
      disabled: el.props.disabled === true,
      className: typeof el.props.className === "string" ? el.props.className : "",
      onClick:
        typeof el.props.onClick === "function" ? (el.props.onClick as () => void) : undefined,
    });
  }
  if (el.type === "input" || el.type === "textarea" || el.type === "select") {
    acc.fields.push({ tag: el.type, id: el.props.id as string | undefined });
  }
  if (el.type === "a") {
    acc.links.push({ href: String(el.props.href), text: textOf(el.props.children).trim() });
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount += 1;
  walk(el.props.children, acc);
}

function render(seed: {
  convo?: Convo | null;
  text?: string;
  error?: string | null;
  navigating?: boolean;
  resumable?: JobPostingChatSessionSummary[];
  loadFailed?: boolean;
}): Collected {
  // useState order in the source: convo, text, error, navigating.
  stateQueue = [seed.convo ?? null, seed.text ?? "", seed.error ?? null, seed.navigating ?? false];
  stateCursor = 0;
  const tree = JobPostingChat({
    resumable: seed.resumable ?? [],
    loadFailed: seed.loadFailed ?? false,
  }) as ReactElement;
  const acc: Collected = { buttons: [], texts: [], fields: [], ariaLiveCount: 0, links: [] };
  walk(tree, acc);
  return acc;
}

const allText = (acc: Collected): string => acc.texts.join(" ");
const button = (acc: Collected, label: string) =>
  acc.buttons.find((b) => b.text.toLowerCase().includes(label.toLowerCase()));

/** Let the mocked `startTransition`'s async callback settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  startJobPostingChatAction.mockReset();
  sendJobPostingChatMessageAction.mockReset();
  resumeJobPostingChatAction.mockReset();
  publishJobPostingChatAction.mockReset();
  push.mockReset();
  refresh.mockReset();
});

/* ── 1. Cross-device pickup ─────────────────────────────────────────────────────── */

describe("choose screen — continue where you left off (cross-device)", () => {
  it("offers CONTINUE (not a blank chat) when an in-progress session exists", () => {
    const acc = render({ resumable: [RESUMABLE] });
    expect(allText(acc)).toContain("Continue where you left off");
    expect(allText(acc)).toContain("CNC Machinist");
    expect(button(acc, "Continue")).toBeDefined();
    // Starting fresh is still offered, but it is the secondary path.
    expect(button(acc, "Start a new chat")).toBeDefined();
  });

  it("shows a plain start CTA (no resume card) when there is nothing to resume", () => {
    const acc = render({ resumable: [] });
    expect(allText(acc)).not.toContain("Continue where you left off");
    expect(button(acc, "Start chat")).toBeDefined();
  });

  it("degrades honestly when the sessions read failed — never fabricates a session", () => {
    const acc = render({ resumable: [], loadFailed: true });
    expect(allText(acc)).toContain("couldn");
    expect(button(acc, "Start chat")).toBeDefined();
  });

  it("Continue calls the resume action with ONLY the session id (XB-A)", async () => {
    resumeJobPostingChatAction.mockResolvedValue({ ok: false, error: "x" });
    const acc = render({ resumable: [RESUMABLE] });
    button(acc, "Continue")?.onClick?.();
    await flush();
    expect(resumeJobPostingChatAction).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    const arg = resumeJobPostingChatAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(arg)).toEqual(["sessionId"]);
  });

  it("Start calls the start action with no arguments at all", async () => {
    startJobPostingChatAction.mockResolvedValue({ ok: false, error: "x" });
    const acc = render({ resumable: [] });
    button(acc, "Start chat")?.onClick?.();
    await flush();
    expect(startJobPostingChatAction).toHaveBeenCalledTimes(1);
  });
});

/* ── 1b. ONE primary on the choose screen (F18) ───────────────────────────────────── */

describe("choose screen — ONE primary action (F18)", () => {
  // The sweep counted three Safety-Yellow buttons here: a Continue per session + Start a new chat.
  const READY_OLDER: JobPostingChatSessionSummary = {
    ...RESUMABLE,
    sessionId: "aaaa1111-0000-4000-8000-000000000002",
    status: "draft_ready",
    draftReady: true,
    lastMessageAt: "2026-07-25T09:00:00.000Z",
  };
  const READY_NEWEST: JobPostingChatSessionSummary = {
    ...RESUMABLE,
    sessionId: "aaaa1111-0000-4000-8000-000000000003",
    status: "draft_ready",
    draftReady: true,
    lastMessageAt: null,
    startedAt: "2026-07-27T09:00:00.000Z",
  };
  const variant = (b: { className: string }) =>
    /\bbb-btn--(primary|secondary)\b/.exec(b.className)?.[1];
  const primaries = (acc: Collected) => acc.buttons.filter((b) => variant(b) === "primary");

  it("Continue on the MOST RECENT ready-to-publish session is the one primary", async () => {
    resumeJobPostingChatAction.mockResolvedValue({ ok: false, error: "x" });
    // The newest conversation overall (RESUMABLE, 07-26) is still in progress: readiness wins.
    const acc = render({ resumable: [RESUMABLE, READY_OLDER, READY_NEWEST] });
    expect(primaries(acc)).toHaveLength(1);
    expect(primaries(acc)[0]!.text).toBe("Continue");
    primaries(acc)[0]!.onClick?.();
    await flush();
    expect(resumeJobPostingChatAction).toHaveBeenCalledWith({ sessionId: READY_NEWEST.sessionId });
  });

  it("every other Continue and Start a new chat are secondary", () => {
    const acc = render({ resumable: [RESUMABLE, READY_OLDER, READY_NEWEST] });
    const continues = acc.buttons.filter((b) => b.text === "Continue");
    expect(continues.map(variant).sort()).toEqual(["primary", "secondary", "secondary"]);
    expect(variant(button(acc, "Start a new chat")!)).toBe("secondary");
  });

  it("nothing ready to publish: the most recent conversation's Continue is the primary", async () => {
    resumeJobPostingChatAction.mockResolvedValue({ ok: false, error: "x" });
    const older = {
      ...RESUMABLE,
      sessionId: READY_OLDER.sessionId,
      lastMessageAt: "2026-07-01T00:00:00.000Z",
    };
    const acc = render({ resumable: [older, RESUMABLE] });
    expect(primaries(acc)).toHaveLength(1);
    primaries(acc)[0]!.onClick?.();
    await flush();
    expect(resumeJobPostingChatAction).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it("nothing to resume: Start chat is the page's one primary", () => {
    const acc = render({ resumable: [] });
    expect(primaries(acc).map((b) => b.text)).toEqual(["Start chat"]);
  });
});

/* ── 1c. The way to the manual form, on BOTH screens ─────────────────────────────── */

describe("the manual form stays one link away on both screens (review of #2037)", () => {
  // Post with AI is a MODE of New posting with no back link (F15), so its own "Use the manual
  // form instead" is the only way to the form in the page — once a chat starts too.
  const manual = (acc: Collected) => acc.links.filter((l) => l.href === "/postings/new");
  const ONE = [{ href: "/postings/new", text: "Use the manual form instead" }];

  it("the choose screen offers it", () => {
    expect(manual(render({ resumable: [RESUMABLE] }))).toEqual(ONE);
    expect(manual(render({ resumable: [] }))).toEqual(ONE);
  });

  it("the chat screen keeps it — mid-conversation and once the draft is ready", () => {
    expect(manual(render({ convo: CONVO }))).toEqual(ONE);
    expect(manual(render({ convo: { ...CONVO, draftReady: true } }))).toEqual(ONE);
  });
});

/* ── 2. The chat surface ────────────────────────────────────────────────────────── */

describe("chat screen — transcript, engine chips, live draft", () => {
  it("renders both sides of the transcript and the engine's suggested answers", () => {
    const acc = render({ convo: CONVO });
    const text = allText(acc);
    expect(text).toContain("What role are you hiring for?");
    expect(text).toContain("CNC operators");
    // The suggestion chips come from the DETERMINISTIC engine — rendered verbatim.
    for (const s of CONVO.suggestions) expect(button(acc, s)).toBeDefined();
  });

  it("renders the live draft with a BANDED vacancy, never a raw head count (ADR-0012)", () => {
    const text = allText(render({ convo: CONVO }));
    expect(text).toContain("Your posting so far");
    expect(text).toContain("6-10");
    expect(text).toContain("Pune, MH");
    expect(text).toContain("₹20,000");
  });

  it("lists what is still missing instead of guessing (engine-reported keys)", () => {
    const convo: Convo = {
      ...CONVO,
      draft: { ...DRAFT, missingFields: ["shift", "pay_min"] },
    };
    const text = allText(render({ convo }));
    expect(text).toContain("Still to cover");
    expect(text).toContain("Shift");
    expect(text).toContain("Pay (min)");
  });

  it("keeps announceable aria-live regions for the transcript and the status", () => {
    expect(render({ convo: CONVO }).ariaLiveCount).toBeGreaterThanOrEqual(2);
  });

  it("sends a suggestion chip straight through as the payer's answer", async () => {
    sendJobPostingChatMessageAction.mockResolvedValue({ ok: false, error: "x" });
    const acc = render({ convo: CONVO });
    button(acc, "6-10")?.onClick?.();
    await flush();
    expect(sendJobPostingChatMessageAction).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: "6-10",
    });
    const arg = sendJobPostingChatMessageAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["sessionId", "text"]);
  });

  it("disables Send on an empty composer", () => {
    expect(button(render({ convo: CONVO, text: "" }), "Send")?.disabled).toBe(true);
    expect(button(render({ convo: CONVO, text: "night shift" }), "Send")?.disabled).toBe(false);
  });
});

/* ── 3. Publish ─────────────────────────────────────────────────────────────────── */

describe("publish — gated on the ENGINE's readiness, routes to the existing detail page", () => {
  it("is disabled until the engine says the draft is ready", () => {
    expect(button(render({ convo: CONVO }), "Publish")?.disabled).toBe(true);
    expect(allText(render({ convo: CONVO }))).toContain("publish unlocks once");
  });

  it("is enabled once draftReady, and sends ONLY the session id", async () => {
    publishJobPostingChatAction.mockResolvedValue({ ok: true, postingId: POSTING_ID });
    const acc = render({ convo: { ...CONVO, draftReady: true } });
    const publish = button(acc, "Publish");
    expect(publish?.disabled).toBe(false);
    publish?.onClick?.();
    await flush();
    expect(publishJobPostingChatAction).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    const arg = publishJobPostingChatAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(arg)).toEqual(["sessionId"]);
  });

  it("routes to the posting's EDIT page on success (PR-B: highlights the worker-card gaps)", async () => {
    publishJobPostingChatAction.mockResolvedValue({
      ok: true,
      postingId: POSTING_ID,
      unsetCardFields: [],
    });
    button(render({ convo: { ...CONVO, draftReady: true } }), "Publish")?.onClick?.();
    await flush();
    // PR-B: publish leaves role_kind + the card fields the interview does not collect NULL, so
    // the chat routes to /edit (where workerCardGaps are highlighted), never the read-only detail.
    expect(push).toHaveBeenCalledWith(`/postings/${POSTING_ID}/edit`);
  });

  it("stays disabled across the success→navigation window (no double publish)", () => {
    const acc = render({ convo: { ...CONVO, draftReady: true }, navigating: true });
    expect(button(acc, "Publishing")?.disabled).toBe(true);
  });

  it("surfaces a publish failure as retryable copy, and does not navigate", async () => {
    publishJobPostingChatAction.mockResolvedValue({ ok: false, error: "Could not publish" });
    button(render({ convo: { ...CONVO, draftReady: true } }), "Publish")?.onClick?.();
    await flush();
    expect(push).not.toHaveBeenCalled();
  });
});

/* ── 4. Rule A — the org name is never asked ────────────────────────────────────── */

describe("rule A — the payer's company/org name is never asked in the chat", () => {
  it("renders no company/org field on either screen", () => {
    for (const acc of [render({ resumable: [RESUMABLE] }), render({ convo: CONVO })]) {
      const ids = acc.fields.map((f) => (f.id ?? "").toLowerCase()).join(" ");
      expect(ids).not.toMatch(/org|company|employer/);
      expect(allText(acc).toLowerCase()).not.toContain("company name?");
    }
  });

  it("the only free-text field in the chat is the answer composer", () => {
    const acc = render({ convo: CONVO });
    expect(acc.fields.map((f) => f.tag)).toEqual(["textarea"]);
    expect(acc.fields[0]?.id).toBe("chatTurn");
  });

  it("tells the payer their company name is filled in automatically", () => {
    expect(allText(render({ convo: CONVO }))).toContain(
      "Your company name is added automatically",
    );
  });
});

/* ── 5. The inline turn screen (UX parity with the manual form) ─────────────────── */

describe("validateTurn — the client-side screen the Server Action re-runs", () => {
  it("rejects empty input", () => {
    expect(validateTurn("   ")).toMatch(/Type an answer/);
  });

  it("rejects an OBVIOUS phone/email (the same looksLikePii heuristic as the manual form)", () => {
    expect(validateTurn("call me on 98765 43210")).toMatch(/contact details/);
    expect(validateTurn("email hr@acme.co")).toMatch(/contact details/);
  });

  it("rejects an over-long turn", () => {
    expect(validateTurn("a".repeat(2001))).toMatch(/too long/);
  });

  it("accepts a normal job answer", () => {
    expect(validateTurn("I need 6 CNC operators in Pune for the night shift")).toBeNull();
  });
});
