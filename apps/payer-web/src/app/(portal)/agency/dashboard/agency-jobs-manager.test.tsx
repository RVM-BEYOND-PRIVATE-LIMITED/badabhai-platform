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
 * rows, creating, editingId, busyId, errorById). `useTransition` → [false, run-immediately].
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./jobs-actions", () => ({
  createAgencyJobAction: vi.fn(),
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
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { ariaLiveCount: 0, text: [] };
  walk(tree, acc);
  return acc;
}

function render(
  jobs: AgencyJob[],
  errorById: Record<string, string | null> = {},
  open: { creating?: boolean; editingId?: string | null } = {},
) {
  // useState order: rows, creating, editingId, busyId, errorById.
  stateQueue = [jobs, open.creating ?? false, open.editingId ?? null, null, errorById];
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
    const { text } = collect(render([JOB], { [JOB.id]: "That vacancy could not be found." }));
    const joined = text.join(" ");
    expect(joined).toContain("That vacancy could not be found.");
    expect(joined).not.toMatch(/\bforbidden\b|employer|consent/i);
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

describe("AgencyJobsManager — the inline editors start level with their host (M1)", () => {
  it("CREATE: the heading is the form's lead (the rail starts at the card's top), and the card is the scroll target", () => {
    const tree = render([JOB], {}, { creating: true });
    const [card] = find(tree, (el) => el.props.id === "agency-create");
    expect(card).toBeDefined();
    const [form] = find(card!, (el) => el.type === AgencyJobFormMock);
    expect(form!.props.mode).toBe("create");
    const lead = form!.props.lead as ReactElement<{ className: string; children: ReactNode }>;
    expect(lead.props.className).toBe("agency-jobs__createtitle");
    // No second heading outside the form.
    expect(find(card!, (el) => el.type === "h3")).toHaveLength(1);
  });

  it("EDIT: the row IS the editor — its header (title, actions, the aria-live error) leads the form column", () => {
    const tree = render([JOB], { [JOB.id]: "That vacancy could not be found." }, { editingId: JOB.id });
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

describe("AgencyJobsManager — Edit / Close edit / Cancel keep focus on the row's toggle", () => {
  /**
   * The row's header moves between the Card and the editor's lead, so React REBUILDS the toggle
   * the payer pressed and its focus falls to <body> (measured: Enter on Edit → BODY, next Tab →
   * "Details"). The manager refocuses the rebuilt toggle by its stable id. The DOM is faked: rAF
   * queues frames the test runs; `getElementById` hands back the toggle where the LAST commit put
   * it — inside the editor's lead while editing.
   */
  const TOGGLE = `agency-job-edit-${JOB.id}`;
  const HOST = `agency-job-${JOB.id}`;
  let frames: Array<() => void> = [];
  let log: string[] = [];
  let toggleInLead = false;
  const runFrame = () => {
    const now = frames;
    frames = [];
    for (const f of now) f();
  };
  beforeEach(() => {
    frames = [];
    log = [];
    vi.stubGlobal("window", {
      requestAnimationFrame: (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      },
    });
    vi.stubGlobal("document", {
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
    expect(toggleOf(render([JOB], {}, { editingId: JOB.id })).props.children).toBe("Close edit");
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

  it("Close edit: focus lands on the rebuilt toggle back in the card, scrolled into view", () => {
    toggleInLead = true;
    toggleOf(render([JOB], {}, { editingId: JOB.id })).props.onClick();
    runFrame();
    expect(log).toEqual([]);
    toggleInLead = false;
    runFrame();
    expect(log).toEqual(["focus toggle (in card, preventScroll=false)"]);
  });

  it("the form's Cancel hands focus back to the toggle too", () => {
    toggleInLead = false; // already committed by the frame
    const tree = render([JOB], {}, { editingId: JOB.id });
    const [form] = find(tree, (el) => el.type === AgencyJobFormMock);
    (form!.props.onCancel as () => void)();
    runFrame();
    expect(log).toEqual(["focus toggle (in card, preventScroll=false)"]);
  });

  it("gives up after a bounded number of frames if the toggle never comes back", () => {
    toggleInLead = true; // never rebuilt into the card
    toggleOf(render([JOB], {}, { editingId: JOB.id })).props.onClick();
    for (let i = 0; i < 20; i++) runFrame();
    expect(log).toEqual([]);
    expect(frames).toEqual([]);
  });
});
