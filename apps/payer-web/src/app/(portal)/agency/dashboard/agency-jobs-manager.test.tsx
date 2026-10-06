import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { AgencyJob } from "../../../../lib/contracts";

/**
 * AGENCY-JOBS-MANAGER tests — A11Y-OF-FAILURE (B8) + guardrails (faceless / no-oracle).
 *
 * DS3.1 re-skin: each vacancy now renders as a DS `Card` with a status `Badge` and DS
 * `Button`s (post/edit/pause/close — the SAME live actions). The walk records only the
 * `aria-live="polite"` regions (native) + text via `children` (DS Card/Badge/Button are
 * hookless function components whose label children stay reachable), so these assertions
 * are UNCHANGED by the re-skin.
 *
 * B8: each per-row error region is wrapped in `aria-live="polite"`, so an assistive
 * technology announces a row lifecycle failure (pause/close).
 * Guardrails: the rendered manager carries only coarse/faceless cells (opaque id, bands,
 * counts) — no worker name/phone/email/employer, and no role-named "forbidden" oracle string.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * rows, editingId, busyId, errorById — the inline `creating` toggle left with the inline create
 * form, which is now its own page). `useTransition` → [false, run-immediately].
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./jobs-actions", () => ({
  updateAgencyJobAction: vi.fn(),
  pauseAgencyJobAction: vi.fn(),
  closeAgencyJobAction: vi.fn(),
}));
// The inline form is unit-tested separately; stub it to an inert marker.
vi.mock("./agency-job-form", () => ({ AgencyJobForm: () => null }));

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

const { AgencyJobsManager } = await import("./agency-jobs-manager");
const { AgencyJobForm: AgencyJobFormMock } = await import("./agency-job-form");

const JOB: AgencyJob = {
  id: "00000001-0000-4000-8000-000000000001",
  status: "open",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: null,
  payMin: 20000,
  payMax: 35000,
  minExperienceYears: 1,
  maxExperienceYears: 5,
  neededBy: "soon",
  applicantsReceived: 3,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

interface Collected {
  ariaLiveCount: number;
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
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; lead?: ReactNode }>;
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
  // An editing row's header leads the (stubbed) form column — walk it too.
  if ("lead" in el.props) walk(el.props.lead, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { ariaLiveCount: 0, text: [] };
  walk(tree, acc);
  return acc;
}

function render(
  jobs: AgencyJob[],
  errorById: Record<string, string | null> = {},
  editingId: string | null = null,
) {
  // useState order: rows, editingId, busyId, errorById.
  stateQueue = [jobs, editingId, null, errorById];
  stateCursor = 0;
  return AgencyJobsManager({ jobs }) as ReactElement;
}

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
});

describe("AgencyJobsManager — A11Y-OF-FAILURE: per-row error region is aria-live='polite' (B8)", () => {
  it("renders one aria-live='polite' error region per active row", () => {
    const { ariaLiveCount } = collect(render([JOB]));
    expect(ariaLiveCount).toBe(1);
    const second = { ...JOB, id: "00000001-0000-4000-8000-000000000002" };
    expect(collect(render([JOB, second])).ariaLiveCount).toBe(2);
  });
});

describe("AgencyJobsManager — guardrails: faceless cells, no oracle", () => {
  it("renders coarse/faceless cells only — no worker name/phone/email/employer", () => {
    const { text } = collect(render([JOB]));
    const joined = text.join(" ");
    expect(joined).not.toMatch(/phone|\bemail\b|employer/i);
    expect(joined).not.toMatch(/\+?\d{7,}/);
  });

  it("a row error renders inside the aria-live region without leaking a role-named oracle", () => {
    const { text } = collect(render([JOB], { [JOB.id]: "That posting could not be found." }));
    const joined = text.join(" ");
    expect(joined).toContain("That posting could not be found.");
    expect(joined).not.toMatch(/\bforbidden\b|employer|consent/i);
  });
});

describe("AgencyJobsManager — Posting naming, one create entry point", () => {
  it("offers no inline create: New posting is its own page, so the list has no second door", () => {
    const joined = collect(render([JOB])).text.join(" ");
    expect(joined).not.toMatch(/Post a vacancy|Post vacancy|Close form|New posting/);
  });

  it("the terminal action says what it ends, and the edit toggle cancels rather than 'closes'", () => {
    const idle = collect(render([JOB])).text.join(" ");
    expect(idle).toContain("Close posting");
    expect(idle).toContain("Edit");
    const editing = collect(render([JOB], {}, JOB.id)).text.join(" ");
    expect(editing).toContain("Cancel");
    expect(editing).not.toContain("Close edit");
  });

  it("an empty list points at New posting in words (no vacancy vocabulary)", () => {
    const joined = collect(render([])).text.join(" ");
    expect(joined).toContain("New posting");
    expect(joined).not.toMatch(/vacanc/i);
  });
});

/** Every element in render order, walking children (DS components are not expanded). */
function elementsOf(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) elementsOf(c, out);
    return out;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  out.push(el);
  if (el.props && "children" in el.props) elementsOf(el.props.children, out);
  return out;
}
const hrefsOf = (tree: ReactNode) =>
  elementsOf(tree)
    .map((e) => (e.props as { href?: unknown }).href)
    .filter((h): h is string => typeof h === "string");
const classOf = (e: ReactElement) => String((e.props as { className?: unknown }).className ?? "");

describe("AgencyJobsManager — aligned with the company list (2026-10-01)", () => {
  it("the TITLE opens the posting's details, and the row also links its REAL applicants (#1956)", () => {
    const tree = render([JOB]);
    const title = elementsOf(tree).find((e) => classOf(e).split(/\s+/).includes("agency-job__title"))!;
    expect((title.props as { href?: string }).href).toBe(`/agency/jobs/${JOB.id}`);
    expect(hrefsOf(tree)).toContain(`/agency/jobs/${JOB.id}/applicants`);
    expect(collect(tree).text.join(" ")).not.toMatch(/\bDetails\b/);
  });

  it("links each agency posting's REAL applicants (#1956 — the feed serves them since #1955)", () => {
    const tree = render([JOB, { ...JOB, id: "00000001-0000-4000-8000-000000000002" }]);
    expect(hrefsOf(tree).filter((h) => h.includes("applicants"))).toEqual([
      `/agency/jobs/${JOB.id}/applicants`,
      "/agency/jobs/00000001-0000-4000-8000-000000000002/applicants",
    ]);
  });

  it("the empty list is the shared state block — titled, explained, and with no button", () => {
    const tree = render([]);
    const els = elementsOf(tree);
    expect(els.some((e) => classOf(e) === "state")).toBe(true);
    expect(els.some((e) => classOf(e) === "state__actions")).toBe(false);
    expect(hrefsOf(tree)).toEqual([]);
    const text = collect(tree).text.join(" ");
    expect(text).toContain("No postings yet");
    expect(text).toContain("use New posting above");
  });
});

/** Elements (host or component) matching `pred`, walking children AND the `lead` prop. */
function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean) {
  const out: Array<ReactElement<Record<string, unknown>>> = [];
  (function visit(n: ReactNode): void {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const el = n as ReactElement<Record<string, unknown> & { children?: ReactNode; lead?: ReactNode }>;
    if (pred(el)) out.push(el);
    if ("children" in el.props) visit(el.props.children);
    if ("lead" in el.props) visit(el.props.lead);
  })(node);
  return out;
}

describe("AgencyJobsManager — the inline editor starts level with its host (M1)", () => {
  it("EDIT: the row IS the editor — its header (title, actions, the aria-live error) leads the form column", () => {
    const tree = render([JOB], { [JOB.id]: "That vacancy could not be found." }, JOB.id);
    const [row] = find(tree, (el) => el.props.id === `agency-job-${JOB.id}`);
    expect(row!.props.className).toBe("agency-job agency-job--editing");
    const [form] = find(row!, (el) => el.type === AgencyJobFormMock);
    expect(form!.props.mode).toBe("edit");
    const lead = form!.props.lead as ReactNode;
    expect(find(lead, (el) => el.props.className === "agency-job__lead")).toHaveLength(1);
    expect(find(lead, (el) => el.props["aria-live"] === "polite")).toHaveLength(1);
    expect(collect(lead).text.join(" ")).toContain("That vacancy could not be found.");
  });

  it("not editing: the row is the plain row (no editor, no editing class)", () => {
    const tree = render([JOB]);
    const [row] = find(tree, (el) => el.props.id === `agency-job-${JOB.id}`);
    expect(row!.props.className).toBe("agency-job");
    expect(find(row!, (el) => el.type === AgencyJobFormMock)).toHaveLength(0);
  });
});

describe("AgencyJobsManager — Edit / Cancel (toggle or form) keep focus on the row's toggle", () => {
  /**
   * The row's header moves between the Card and the editor's lead, so React REBUILDS the toggle
   * the payer pressed and its focus falls to <body> (measured: Enter on Edit → BODY, next Tab →
   * "Details"). The manager refocuses the rebuilt toggle by its stable id. The DOM is faked: rAF
   * queues frames the test runs; `getElementById` hands back the toggle where the LAST commit put
   * it — inside the editor's lead while editing; `activeElement` is where focus is when a frame
   * runs — <body> once a rebuild dropped it, or wherever the payer moved while a save was in flight.
   */
  const TOGGLE = `agency-job-edit-${JOB.id}`;
  const HOST = `agency-job-${JOB.id}`;
  const BODY = { tagName: "BODY" };
  let frames: Array<() => void> = [];
  let log: string[] = [];
  let toggleInLead = false;
  let activeElement: object | null = BODY;
  const runFrame = () => {
    const now = frames;
    frames = [];
    for (const f of now) f();
  };
  beforeEach(() => {
    frames = [];
    log = [];
    activeElement = BODY;
    vi.stubGlobal("window", {
      requestAnimationFrame: (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      },
    });
    vi.stubGlobal("document", {
      body: BODY,
      get activeElement() {
        return activeElement;
      },
      getElementById: (id: string) => {
        if (id === HOST) return { scrollIntoView: () => log.push("scroll host") };
        if (id !== TOGGLE) return null;
        return {
          closest: (sel: string) => (sel === ".agency-job__lead" && toggleInLead ? {} : null),
          focus: (o: { preventScroll?: boolean }) =>
            log.push(`focus toggle (${toggleInLead ? "in lead" : "in card"}, preventScroll=${o.preventScroll})`),
        };
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const toggleOf = (tree: ReactNode) => {
    const [t] = find(tree, (el) => el.props.id === TOGGLE);
    expect(t, "the row's toggle carries a stable id").toBeDefined();
    return t as ReactElement<{ onClick: () => void; children: ReactNode }>;
  };

  it("the toggle has the SAME id whether the row is editing or not (so focus can find it again)", () => {
    expect(toggleOf(render([JOB])).props.children).toBe("Edit");
    expect(toggleOf(render([JOB], {}, JOB.id)).props.children).toBe("Cancel");
  });

  it("Edit: focus lands on the REBUILT toggle (in the editor's lead), after the scroll, without its own", () => {
    toggleInLead = false; // the commit has not happened yet in the first frame
    toggleOf(render([JOB])).props.onClick();
    runFrame(); // revealEditor scrolls; the old toggle (still in the card) is not the one → wait
    expect(log).toEqual(["scroll host"]);
    toggleInLead = true; // React committed: the header now leads the form
    runFrame();
    expect(log).toEqual(["scroll host", "focus toggle (in lead, preventScroll=true)"]);
  });

  it("Cancel (the toggle): focus lands on the rebuilt toggle back in the card, scrolled into view", () => {
    toggleInLead = true;
    toggleOf(render([JOB], {}, JOB.id)).props.onClick();
    runFrame();
    expect(log).toEqual([]);
    toggleInLead = false;
    runFrame();
    expect(log).toEqual(["focus toggle (in card, preventScroll=false)"]);
  });

  it("the form's Cancel hands focus back to the toggle too", () => {
    toggleInLead = false; // already committed by the frame
    const tree = render([JOB], {}, JOB.id);
    const [form] = find(tree, (el) => el.type === AgencyJobFormMock);
    (form!.props.onCancel as () => void)();
    runFrame();
    expect(log).toEqual(["focus toggle (in card, preventScroll=false)"]);
  });

  it("waits while the OLD toggle still holds focus, then refocuses once the rebuild dropped it", () => {
    const pressed = { id: TOGGLE }; // the toggle the payer pressed, not yet replaced by the commit
    activeElement = pressed;
    toggleInLead = false;
    toggleOf(render([JOB])).props.onClick();
    runFrame(); // not rebuilt yet: keep waiting, whatever holds focus
    expect(log).toEqual(["scroll host"]);
    expect(frames).toHaveLength(1);
    toggleInLead = true; // committed: the old toggle is gone, its focus fell to <body>
    activeElement = BODY;
    runFrame();
    expect(log).toEqual(["scroll host", "focus toggle (in lead, preventScroll=true)"]);
  });

  /** Row 1's editor, its submit handler, and the editingId setter of that render. */
  async function saveFromEditor() {
    const actions = await import("./jobs-actions");
    vi.mocked(actions.updateAgencyJobAction).mockResolvedValueOnce({ ok: true, job: JOB });
    const first = useState.mock.results.length;
    const tree = render([JOB], {}, JOB.id);
    // useState order: rows, editingId, busyId, errorById — the editingId setter is the second.
    const setEditingId = useState.mock.results[first + 1]!.value[1] as ReturnType<typeof vi.fn>;
    const [form] = find(tree, (el) => el.type === AgencyJobFormMock);
    const submit = form!.props.onSubmit as (input: unknown) => Promise<{ ok: boolean }>;
    return { submit, setEditingId };
  }

  it("a successful save hands focus back to the toggle when the rebuild dropped it to <body>", async () => {
    toggleInLead = false; // the closed row's header is back in the card
    const { submit } = await saveFromEditor();
    await expect(submit({})).resolves.toEqual({ ok: true });
    runFrame();
    expect(log).toEqual(["focus toggle (in card, preventScroll=false)"]);
  });

  it("a save never steals focus the payer moved elsewhere while it was in flight", async () => {
    toggleInLead = false;
    const { submit } = await saveFromEditor();
    activeElement = { id: "title" }; // typing in another row's editor when the save lands
    await expect(submit({})).resolves.toEqual({ ok: true });
    runFrame();
    expect(log).toEqual([]); // no focus, so no scroll to the saved row
    expect(frames).toEqual([]); // and it does not keep waiting for focus to come back
  });

  it("a save closes only ITS editor — another row's editor opened meanwhile stays open", async () => {
    const { submit, setEditingId } = await saveFromEditor();
    await submit({});
    expect(setEditingId).toHaveBeenCalledTimes(1);
    const update = setEditingId.mock.calls[0]![0] as (cur: string | null) => string | null;
    expect(typeof update).toBe("function");
    expect(update(JOB.id)).toBeNull();
    expect(update("00000001-0000-4000-8000-000000000002")).toBe("00000001-0000-4000-8000-000000000002");
    expect(update(null)).toBeNull();
  });

  it("gives up after a bounded number of frames if the toggle never comes back", () => {
    toggleInLead = true; // never rebuilt into the card
    toggleOf(render([JOB], {}, JOB.id)).props.onClick();
    for (let i = 0; i < 20; i++) runFrame();
    expect(log).toEqual([]);
    expect(frames).toEqual([]);
  });
});
