import { describe, expect, it, vi, beforeEach } from "vitest";
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
  it("the TITLE opens the posting's details — the row's one link (no separate 'Details')", () => {
    const tree = render([JOB]);
    const title = elementsOf(tree).find((e) => classOf(e).split(/\s+/).includes("agency-job__title"))!;
    expect((title.props as { href?: string }).href).toBe(`/agency/jobs/${JOB.id}`);
    expect(hrefsOf(tree)).toEqual([`/agency/jobs/${JOB.id}`]);
    expect(collect(tree).text.join(" ")).not.toMatch(/\bDetails\b/);
  });

  it("never links an agency posting's applicants (no page for them until backend #1898)", () => {
    const tree = render([JOB, { ...JOB, id: "00000001-0000-4000-8000-000000000002" }]);
    expect(hrefsOf(tree).filter((h) => h.includes("applicants"))).toEqual([]);
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
