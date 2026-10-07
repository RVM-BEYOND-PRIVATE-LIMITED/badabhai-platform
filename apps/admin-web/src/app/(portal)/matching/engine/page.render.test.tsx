import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Engine view RENDERS: the gate it asks for, the three columns in the server's order,
 * and the absence of any identity. The live client half renders here as its first (server)
 * paint — polling and diffing run in effects, which are covered by the presenter tests.
 */

const stub = vi.hoisted(() => ({
  gate: [] as string[],
  worker: null as unknown,
  posting: null as unknown,
  workerFailure: null as unknown,
}));

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (cap: string) => {
    stub.gate.push(cap);
    return { adminId: "a-1", role: "analyst", capabilities: ["read_entities"] };
  },
}));

vi.mock("../../../../lib/match-engine", () => ({
  listEngineWorkers: async () => ({
    workers: [
      {
        worker_id: "5eeded00-0001-4a00-8000-000000000001",
        short_ref: "5eeded00",
        created_at: "2026-10-01T09:00:00.000Z",
        trade_label: "CNC Turning",
      },
    ],
  }),
  getEngineWorker: async () => {
    if (stub.workerFailure) throw stub.workerFailure;
    return stub.worker;
  },
  getEnginePosting: async () => stub.posting,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const { default: EngineViewPage } = await import("./page");
const { AdminRequestError } = await import("../../../../lib/admin-http");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";
const P1 = "bc765f2b-902f-4cba-81c2-6abab75e4bf5";
const P2 = "bc765f2b-902f-4cba-81c2-6abab75e4bf6";

const card = (id: string, rank: number, tier: 1 | 2, title: string, why: string) => ({
  rank,
  job_posting_id: id,
  role_title: title,
  role_kind: "cnc_turner",
  city: "Pune",
  match_tier: tier,
  matched_skill_id: "mskill_cnc_turning",
  matched_skill_label: "CNC Turning",
  boosted: rank === 1,
  published_at: null,
  why,
});

const WORKER = {
  worker_id: WORKER_ID,
  short_ref: "5eeded00",
  skills: [
    {
      skill_id: "mskill_cnc_turning",
      label: "CNC Turning",
      wants: true,
      months_bucketed: 24,
      source: "interview",
    },
    {
      skill_id: "mskill_welding",
      label: "Welding",
      wants: false,
      months_bucketed: 6,
      source: "derived_coarse",
    },
  ],
  funnel: {
    open_postings: 10,
    reached_direct: 3,
    reached_related: 2,
    hidden: 5,
    already_actioned: 1,
  },
  cards: [
    card(P2, 1, 2, "VMC Operator", "related: CNC Turning → VMC Milling"),
    card(P1, 2, 1, "CNC Turner", "direct: CNC Turning"),
  ],
  card_cap: 50,
  generated_at: "2026-10-05T10:00:03.000Z",
};

const render = async (sp: Record<string, string>) =>
  renderToStaticMarkup(await EngineViewPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  stub.gate = [];
  stub.worker = WORKER;
  stub.posting = null;
  stub.workerFailure = null;
});

describe("Engine view page", () => {
  it("gates on read_entities — the capability on every engine API read", async () => {
    await render({});
    expect(stub.gate).toEqual(["read_entities"]);
  });

  it("shows the picker by short ref and asks for a pick before reading a worker", async () => {
    const html = await render({});
    expect(html).toContain("5eeded00");
    expect(html).toContain("CNC Turning");
    expect(html).toContain("Pick a demo worker");
  });

  it("renders skills, a funnel that adds up, and cards in the server's order", async () => {
    const html = await render({ worker: WORKER_ID });
    expect(html).toContain("Welding");
    expect(html).toContain("engine__skill--off");
    // Funnel numbers, top to bottom.
    const values = [...html.matchAll(/engine__step-value">(\d+)</g)].map((m) => Number(m[1]));
    expect(values).toEqual([10, 3, 2, 5]);
    expect(values[0]).toBe(values[1]! + values[2]! + values[3]!);
    expect(html).not.toContain("do not add up");
    // Feed order is exactly the API's: VMC (rank 1) before CNC Turner (rank 2).
    expect(html.indexOf("VMC Operator")).toBeLessThan(html.indexOf("CNC Turner"));
    expect(html).toContain("related: CNC Turning → VMC Milling");
    expect(html).toContain("direct: CNC Turning");
    expect(html).toContain("engine-tier--related");
    expect(html).toContain("Boosted");
    expect(html).toContain("Live");
  });

  it("says when the funnel does not add up", async () => {
    stub.worker = { ...WORKER, funnel: { ...WORKER.funnel, hidden: 4 } };
    expect(await render({ worker: WORKER_ID })).toContain("do not add up");
  });

  it("is a neutral not-available state on a 404, and never reads a malformed id", async () => {
    stub.workerFailure = new AdminRequestError(404, "Not found");
    expect(await render({ worker: WORKER_ID })).toContain("not available");
    stub.workerFailure = null;
    expect(await render({ worker: "not-a-uuid" })).toContain("Pick a demo worker");
  });

  it("renders a posting's reach by tier and its ranked applicants by short ref", async () => {
    stub.posting = {
      job_posting_id: P1,
      role_title: "CNC Turner",
      role_kind: null,
      status: "open",
      city: "Pune",
      posted_skills: [{ skill_id: "mskill_cnc_turning", label: "CNC Turning" }],
      related_skills: [{ skill_id: "mskill_vmc", label: "VMC Milling" }],
      reach: { total: 7, tier1: 4, tier2: 3 },
      candidates: [
        {
          rank: 1,
          worker_id: WORKER_ID,
          short_ref: "5eeded00",
          application_id: "ap-1",
          match_tier: 2,
          effective_tier: 1,
          skill_months: 30,
          industry_months: 40,
          last_worked_at: "2026-09-01",
          matched_skill_label: "VMC Milling",
        },
      ],
      tier_floor_months: 24,
      generated_at: "2026-10-05T10:00:03.000Z",
    };
    const html = await render({ tab: "posting", posting: P1 });
    expect(html).toContain("VMC Milling");
    const values = [...html.matchAll(/engine__step-value">(\d+)</g)].map((m) => Number(m[1]));
    expect(values).toEqual([7, 4, 3]);
    expect(html).toContain("5eeded00");
    expect(html).toContain("after 24 months");
  });
});

const POSTING = {
  job_posting_id: P1,
  role_title: "CNC Turner",
  role_kind: null,
  status: "open",
  city: "Pune",
  posted_skills: [{ skill_id: "mskill_cnc_turning", label: "CNC Turning" }],
  related_skills: [],
  reach: { total: 1, tier1: 1, tier2: 0 },
  candidates: [
    {
      rank: 1,
      worker_id: "5eeded00-0001-4a00-8000-000000000002",
      short_ref: "5eeded01",
      application_id: "ap-1",
      match_tier: 1,
      effective_tier: 1,
      skill_months: 30,
      industry_months: null,
      last_worked_at: null,
      matched_skill_label: "CNC Turning",
    },
  ],
  tier_floor_months: 24,
  generated_at: "2026-10-05T10:00:03.000Z",
};

/** Every `<a … href="…">` on the page, as `{ href, tag }`. */
const anchors = (html: string) =>
  [...html.matchAll(/<a [^>]*>/g)].map((m) => ({
    tag: m[0],
    href: (/href="([^"]*)"/.exec(m[0])?.[1] ?? "").replaceAll("&amp;", "&"),
  }));

describe("one link per target on the stage (final re-sweep NEW-05)", () => {
  it("the selected worker is shown in the picker, not linked to the page it is already on", async () => {
    const html = await render({ worker: WORKER_ID });
    // The Worker tab is the one link to this address; the picker marks the selection instead.
    const self = anchors(html).filter((a) => a.href === `/matching/engine?worker=${WORKER_ID}`);
    expect(self.map((a) => a.tag)).toHaveLength(1);
    expect(self[0]!.tag).toContain("engine__tab");
    const pick =
      /<(\w+)[^>]*class="engine__pick"[^>]*aria-current="true"[^>]*>|<(\w+)[^>]*aria-current="true"[^>]*class="engine__pick"[^>]*>/.exec(
        html,
      );
    expect(pick, "the selected pill is still marked for assistive tech").not.toBeNull();
    expect(pick![1] ?? pick![2]).not.toBe("a");
  });

  it("an unselected worker in the picker is still a link", async () => {
    const html = await render({});
    expect(
      anchors(html).some((a) => a.tag.includes("engine__pick") && a.href.includes("worker=")),
    ).toBe(true);
  });

  it("the posting tab has no 'Back to the worker' — the Worker tab is the way back", async () => {
    stub.posting = POSTING;
    const html = await render({ worker: WORKER_ID, tab: "posting", posting: P1 });
    expect(html).not.toContain("Back to the worker");
    const back = anchors(html).filter((a) => a.href === `/matching/engine?worker=${WORKER_ID}`);
    expect(back.map((a) => a.tag)).toHaveLength(1);
    expect(back[0]!.tag).toContain("engine__tab");
  });
});

describe("touch targets on the stage (final re-sweep NEW-04)", () => {
  it("an applicant's worker link takes the console's table-link class, so it is 44px on touch", async () => {
    // A bare `<a class="mono">` was 90x22 on a touch screen: the coarse-pointer table-link rule
    // (`.table :is(td, th) > .link`, a11y-foundations.css.test.ts) reaches `.link` only.
    stub.posting = POSTING;
    const html = await render({ tab: "posting", posting: P1 });
    const rows = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const links = [...rows.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(1);
    for (const tag of links) expect(/class="([^"]*)"/.exec(tag)?.[1]?.split(" ")).toContain("link");
  });
});
