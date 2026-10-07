import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { AgencyJob } from "../../../../lib/contracts";
import { Button } from "../../../../components/ds";

/**
 * AGENCY-JOBS-MANAGER tests — A11Y-OF-FAILURE (B8) + guardrails (faceless / no-oracle) + the row's
 * doors and lifecycle buttons.
 *
 * DS3.1 re-skin: each posting renders as a DS `Card` with a status `Badge` and DS `Button`s. The
 * walk records only the `aria-live="polite"` regions (native) + text via `children` (DS
 * Card/Badge/Button are hookless function components whose label children stay reachable).
 *
 * B8: each per-row error region is wrapped in `aria-live="polite"`, so an assistive technology
 * announces a row lifecycle failure (pause/resume/close).
 * Guardrails: the rendered manager carries only coarse/faceless cells (opaque id, bands, counts) —
 * no worker name/phone/email/employer, and no role-named "forbidden" oracle string.
 *
 * FINAL SWEEP (F02/F28): the inline row editor is RETIRED — a row's "Edit posting" is a link to
 * the posting's own edit page (`/agency/jobs/<id>/edit`), whose tests carry the editor's save
 * assertions (edit mode, the posting as the clear-diff `initial`, the page head as the form's
 * lead). The editor's focus hand-back tests (toggle ↔ rebuilt header) and its "a save closes only
 * ITS editor" test went with it: there is no toggle, no header rebuild and one form per page.
 * F39: a lifecycle press shows loading on THAT button only; the row's other buttons are disabled.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order: rows,
 * busyById, errorById — `editingId` left with the inline editor, so the busy slot and `errorById`
 * moved up one position; the busy slot is now `Record<jobId, action>` — PER ROW, so two rows
 * working at once never overwrite each other (review L3)). `useTransition` → [false, run-now].
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./jobs-actions", () => ({
  pauseAgencyJobAction: vi.fn(async () => ({ ok: false, error: "x" })),
  resumeAgencyJobAction: vi.fn(async () => ({ ok: false, error: "x" })),
  closeAgencyJobAction: vi.fn(async () => ({ ok: false, error: "x" })),
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

const { AgencyJobsManager } = await import("./agency-jobs-manager");
const actions = await import("./jobs-actions");

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
const JOB2: AgencyJob = { ...JOB, id: "00000001-0000-4000-8000-000000000002" };

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

type Busy = Record<string, "pause" | "resume" | "close">;

function render(jobs: AgencyJob[], errorById: Record<string, string | null> = {}, busy: Busy = {}) {
  // useState order: rows, busyById, errorById.
  stateQueue = [jobs, busy, errorById];
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
    expect(collect(render([JOB, JOB2])).ariaLiveCount).toBe(2);
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

  it("the terminal action says what it ends; Edit opens a page, so no row reads 'Cancel'", () => {
    const idle = collect(render([JOB])).text.join(" ");
    expect(idle).toContain("Close posting");
    expect(idle).toContain("Edit");
    expect(idle).not.toContain("Cancel");
    expect(idle).not.toContain("Close edit");
  });

  it("the row's edit door reads 'Edit posting' — the words its details header and the company list use (R2)", () => {
    /** The text of every DS button in the tree (links, buttons and the disabled stand-in). */
    const buttonLabels = (tree: ReactNode) =>
      elementsOf(tree)
        .filter((e) => classOf(e).split(/\s+/).includes("bb-btn"))
        .map((e) =>
          collect((e.props as { children?: ReactNode }).children)
            .text.join("")
            .trim(),
        );
    const idle = buttonLabels(render([JOB]));
    expect(idle).toContain("Edit posting");
    expect(idle).not.toContain("Edit");
    // …and the disabled stand-in shown while the row works says the same.
    const busy = buttonLabels(render([JOB], {}, { [JOB.id]: "close" }));
    expect(busy).toContain("Edit posting");
    expect(busy).not.toContain("Edit");
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
    const title = elementsOf(tree).find((e) =>
      classOf(e).split(/\s+/).includes("agency-job__title"),
    )!;
    expect((title.props as { href?: string }).href).toBe(`/agency/jobs/${JOB.id}`);
    expect(hrefsOf(tree)).toContain(`/agency/jobs/${JOB.id}/applicants`);
    expect(collect(tree).text.join(" ")).not.toMatch(/\bDetails\b/);
  });

  it("links each agency posting's REAL applicants (#1956 — the feed serves them since #1955)", () => {
    const tree = render([JOB, JOB2]);
    expect(hrefsOf(tree).filter((h) => h.includes("applicants"))).toEqual([
      `/agency/jobs/${JOB.id}/applicants`,
      `/agency/jobs/${JOB2.id}/applicants`,
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

describe("AgencyJobsManager — Edit opens the posting's own page (F02/F28: the inline editor is retired)", () => {
  it("an open or a paused row links its edit page", () => {
    const paused = { ...JOB2, status: "paused" as const };
    expect(hrefsOf(render([JOB, paused])).filter((h) => h.endsWith("/edit"))).toEqual([
      `/agency/jobs/${JOB.id}/edit`,
      `/agency/jobs/${JOB2.id}/edit`,
    ]);
  });

  it("a closed or suspended row has no edit door (the same rule as its details header)", () => {
    for (const status of ["closed", "suspended"] as const) {
      expect(
        hrefsOf(render([{ ...JOB, status }])).filter((h) => h.endsWith("/edit")),
        status,
      ).toEqual([]);
    }
  });

  it("the row never hosts a form, and no row is ever an 'editing' row", () => {
    const els = elementsOf(render([JOB, JOB2]));
    expect(els.some((e) => e.type === "form")).toBe(false);
    expect(els.some((e) => /editing|__lead/.test(classOf(e)))).toBe(false);
    expect(els.some((e) => (e.props as { lead?: unknown }).lead !== undefined)).toBe(false);
  });
});

/** The DS lifecycle Buttons of the tree, by their idle label. */
function lifecycleButtons(tree: ReactNode) {
  return elementsOf(tree)
    .filter((e) => e.type === Button)
    .map(
      (e) =>
        e.props as {
          children: ReactNode;
          loading?: boolean;
          disabled?: boolean;
          onClick: () => void;
        },
    );
}
const labelOf = (b: { children: ReactNode }) => collect(b.children).text.join("");

describe("AgencyJobsManager — F39: loading shows on the pressed button only", () => {
  it("idle: no button is loading or disabled", () => {
    for (const b of lifecycleButtons(render([JOB]))) {
      expect(b.loading, labelOf(b)).toBeFalsy();
      expect(b.disabled, labelOf(b)).toBeFalsy();
    }
  });

  it("pausing: ONLY Pause spins (and says so); Close posting is disabled, not loading", () => {
    const [pause, close] = lifecycleButtons(render([JOB], {}, { [JOB.id]: "pause" }));
    expect(labelOf(pause!)).toBe("Pausing…");
    expect(pause!.loading).toBe(true);
    expect(labelOf(close!)).toBe("Close posting");
    expect(close!.loading).toBe(false);
    expect(close!.disabled).toBe(true);
  });

  it("closing: ONLY Close posting spins; Pause keeps its label and is disabled", () => {
    const [pause, close] = lifecycleButtons(render([JOB], {}, { [JOB.id]: "close" }));
    expect(labelOf(close!)).toBe("Closing…");
    expect(close!.loading).toBe(true);
    expect(labelOf(pause!)).toBe("Pause");
    expect(pause!.loading).toBe(false);
    expect(pause!.disabled).toBe(true);
  });

  it("resuming a paused row: ONLY Resume spins", () => {
    const paused = { ...JOB, status: "paused" as const };
    const [resume, close] = lifecycleButtons(render([paused], {}, { [JOB.id]: "resume" }));
    expect(labelOf(resume!)).toBe("Resuming…");
    expect(resume!.loading).toBe(true);
    expect(close!.loading).toBe(false);
    expect(close!.disabled).toBe(true);
  });

  it("another row's buttons stay live while one row works", () => {
    const buttons = lifecycleButtons(render([JOB, JOB2], {}, { [JOB.id]: "pause" }));
    const [, , pause2, close2] = buttons;
    for (const b of [pause2!, close2!]) {
      expect(b.loading).toBe(false);
      expect(b.disabled).toBe(false);
    }
    expect(labelOf(pause2!)).toBe("Pause");
  });

  /** The busy-slot setter of the render that starts at `first` (useState order: rows, busyById, …). */
  const busySetter = (first: number) =>
    useState.mock.results[first + 1]!.value[1] as ReturnType<typeof vi.fn>;
  /** Apply every functional update the setter received, in order, to `start`. */
  const applyUpdates = (setter: ReturnType<typeof vi.fn>, start: Busy): Busy =>
    setter.mock.calls.reduce((acc: Busy, [u]) => (typeof u === "function" ? u(acc) : u), start);

  it("pressing a button records WHICH action is running on THAT row, then calls that action", () => {
    const first = useState.mock.results.length;
    const tree = render([JOB]);
    const setBusy = busySetter(first);
    const [pause] = lifecycleButtons(tree);
    pause!.onClick();
    expect(applyUpdates(setBusy, {})).toEqual({ [JOB.id]: "pause" });
    expect(vi.mocked(actions.pauseAgencyJobAction)).toHaveBeenCalledWith({ jobId: JOB.id });
    const [, close] = lifecycleButtons(render([JOB]));
    close!.onClick();
    expect(vi.mocked(actions.closeAgencyJobAction)).toHaveBeenCalledWith({ jobId: JOB.id });
  });
});

describe("AgencyJobsManager — review L3: the busy state is PER ROW", () => {
  const busySetter = (first: number) =>
    useState.mock.results[first + 1]!.value[1] as ReturnType<typeof vi.fn>;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("two rows working at once each show THEIR own action", () => {
    const [pause1, close1, pause2, close2] = lifecycleButtons(
      render([JOB, JOB2], {}, { [JOB.id]: "pause", [JOB2.id]: "close" }),
    );
    expect(labelOf(pause1!)).toBe("Pausing…");
    expect(pause1!.loading).toBe(true);
    expect(close1!.loading).toBe(false);
    expect(close1!.disabled).toBe(true);
    expect(labelOf(close2!)).toBe("Closing…");
    expect(close2!.loading).toBe(true);
    expect(pause2!.loading).toBe(false);
    expect(pause2!.disabled).toBe(true);
  });

  it("a press marks its row and leaves another row's running action in place", () => {
    const first = useState.mock.results.length;
    const tree = render([JOB, JOB2], {}, { [JOB2.id]: "close" });
    const setBusy = busySetter(first);
    const [pause1] = lifecycleButtons(tree);
    pause1!.onClick();
    const update = setBusy.mock.calls[0]![0] as (b: Busy) => Busy;
    expect(typeof update).toBe("function");
    expect(update({ [JOB2.id]: "close" })).toEqual({ [JOB2.id]: "close", [JOB.id]: "pause" });
  });

  it("a finished action clears ONLY its own row — the other row keeps spinning", async () => {
    const first = useState.mock.results.length;
    const tree = render([JOB, JOB2], {}, { [JOB2.id]: "close" });
    const setBusy = busySetter(first);
    const [pause1] = lifecycleButtons(tree);
    pause1!.onClick();
    await flush();
    const updates = setBusy.mock.calls.map(([u]) => u as (b: Busy) => Busy);
    expect(updates).toHaveLength(2);
    expect(updates[1]!({ [JOB.id]: "pause", [JOB2.id]: "close" })).toEqual({ [JOB2.id]: "close" });
  });
});

describe("AgencyJobsManager — review L2: no edit door while the row works", () => {
  /** The row's Edit control: [element type, href, aria-disabled]. */
  function editOf(tree: ReactNode, jobId: string) {
    const rows = elementsOf(tree).filter((e) => classOf(e).split(/\s+/).includes("agency-job"));
    const row = rows.find((r) =>
      elementsOf(r).some((e) => (e.props as { href?: string }).href === `/agency/jobs/${jobId}`),
    )!;
    const edit = elementsOf(row).find(
      (e) =>
        collect((e.props as { children?: ReactNode }).children)
          .text.join("")
          .trim() === "Edit posting" && classOf(e).includes("bb-btn"),
    )!;
    const p = edit.props as { href?: string; "aria-disabled"?: string };
    return { href: p.href, ariaDisabled: p["aria-disabled"] };
  }

  it("idle: Edit is a link to the posting's edit page", () => {
    expect(editOf(render([JOB]), JOB.id)).toEqual({
      href: `/agency/jobs/${JOB.id}/edit`,
      ariaDisabled: undefined,
    });
  });

  it("while Close (or any action) runs, Edit is NOT a link — it is shown disabled", () => {
    // Close, then Edit, landed on an edit page whose save can never succeed (closed is terminal).
    for (const action of ["close", "pause"] as const) {
      const tree = render([JOB, JOB2], {}, { [JOB.id]: action });
      expect(editOf(tree, JOB.id), action).toEqual({ href: undefined, ariaDisabled: "true" });
      expect(hrefsOf(tree)).not.toContain(`/agency/jobs/${JOB.id}/edit`);
      // …the other row keeps its door.
      expect(editOf(tree, JOB2.id).href).toBe(`/agency/jobs/${JOB2.id}/edit`);
    }
  });
});
