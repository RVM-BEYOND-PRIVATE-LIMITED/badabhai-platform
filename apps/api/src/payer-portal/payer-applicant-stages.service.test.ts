import "reflect-metadata";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Logger, NotFoundException } from "@nestjs/common";
import { validateEvent } from "@badabhai/event-schema";
import type { ApplicantPostingKind } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import {
  PayerApplicantStagesService,
  readStoredStage,
  withStages,
} from "./payer-applicant-stages.service";
import type { ApplicantStageKey } from "./payer-applicant-stages.repository";
import {
  memoryStagesRepo,
  stagesOff,
  STAGES_TABLE_READ_WHILE_OFF,
} from "./payer-applicant-stages.test-support";
import { APPLICANT_NOT_FOUND } from "./payer-applicant-stage.dto";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import {
  defaultModeResolver,
  ownTenantKey,
  resolverOver,
} from "../payers/payer-tenant-scope.test-support";
import type { ServerConfig } from "@badabhai/config";

/**
 * The payer applicant pipeline board at the service seam (owner ruling 2026-10-07).
 *
 * The repository is the in-memory board (`memoryStagesRepo`) — one row per key, an insert that
 * finds a row returns false — with ownership and feed membership mirroring their SQL WHEREs
 * (`findOwnedJobRef`: owner = session payer; `feedMembershipStatement`: an applied, non-leaving
 * applicant of that posting). The SQL itself is pinned in payer-applicant-stages.repository.test.ts
 * and run on Postgres in payer-applicant-stages.db.test.ts. Every rejection is also run through the
 * app's real `AllExceptionsFilter`, so "the same 404" is a claim about the HTTP body.
 */

const PAYER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAYER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
/** A's tenant key, minted by the REAL resolver in the default mode (ADR-0053). */
let KEY_A!: TenantKey;
beforeAll(async () => {
  KEY_A = await ownTenantKey(PAYER_A);
});
const POSTING_A = "0c000000-0000-4000-8000-0000000000a1"; // company posting, A
const JOB_A = "0a000000-0000-4000-8000-0000000000a1"; // agency job, A
const POSTING_B = "0c000000-0000-4000-8000-0000000000b1"; // company posting, B
const UNKNOWN = "0f000000-0000-4000-8000-00000000ffff";
const APPLICANT = "33333333-3333-4333-8333-000000000001";
const APPLICANT_2 = "33333333-3333-4333-8333-000000000002";
const STRANGER = "33333333-3333-4333-8333-0000000000ff"; // applied to nothing of A's
const NOW = new Date("2026-10-07T10:00:00.000Z");
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};

const POSTINGS = new Map<string, { owner: string; kind: ApplicantPostingKind }>([
  [POSTING_A, { owner: PAYER_A, kind: "company_posting" }],
  [JOB_A, { owner: PAYER_A, kind: "agency_job" }],
  [POSTING_B, { owner: PAYER_B, kind: "company_posting" }],
]);
/** (posting, worker) pairs on a feed. B's posting has APPLICANT too — never reachable by A. */
const MEMBERS = new Set([
  `${POSTING_A}|${APPLICANT}`,
  `${POSTING_A}|${APPLICANT_2}`,
  `${JOB_A}|${APPLICANT}`,
  `${POSTING_B}|${APPLICANT}`,
]);

function make(
  over: {
    enabled?: boolean;
    /** ADR-0053 — the REAL resolver; the default mode (`off`) unless a case builds another. */
    tenancy?: PayerTenantScopeService;
  } = {},
) {
  const repo = memoryStagesRepo({
    postings: POSTINGS,
    isMember: (k: ApplicantStageKey) => MEMBERS.has(`${k.postingId}|${k.workerId}`),
  });
  const spied = {
    findOwnedPostingKind: vi.spyOn(repo, "findOwnedPostingKind"),
    isFeedApplicant: vi.spyOn(repo, "isFeedApplicant"),
    lockStage: vi.spyOn(repo, "lockStage"),
    insertStage: vi.spyOn(repo, "insertStage"),
    updateStage: vi.spyOn(repo, "updateStage"),
    withTransaction: vi.spyOn(repo, "withTransaction"),
    listPostingStages: vi.spyOn(repo, "listPostingStages"),
  };
  // The real validation every emitted event goes through, so a payload the registry would refuse
  // fails here exactly as it would in EventsService.
  const emitted: Record<string, unknown>[] = [];
  const emit = vi.fn(async (params: Record<string, unknown>) => {
    const { correlationId, requestId: _r, tx: _tx, ...rest } = params;
    const result = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_version: 1,
      occurred_at: NOW.toISOString(),
      source: "api",
      correlation_id: correlationId,
      causation_id: null,
      metadata: { environment: "test", service: "api" },
      ...rest,
    });
    if (!result.success) throw new Error(`invalid event: ${JSON.stringify(result.error)}`);
    emitted.push(params);
  });
  const svc = new PayerApplicantStagesService(
    repo as never,
    { emit } as never,
    { PAYER_APPLICANT_STAGES_ENABLED: over.enabled ?? true },
    over.tenancy ?? defaultModeResolver(),
  );
  return { svc, repo, spied, emit, emitted };
}

/** What the client receives for a rejection: the real global filter's status + error object. */
function httpOutcome(err: unknown): { status: number; error: unknown } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status: (s: number) => {
      status = s;
      return { json: (b: Record<string, unknown>) => void (body = b) };
    },
  };
  const req = { method: "PUT", url: "/payer/reach/jobs/x/applicants/y/stage", requestId: "r" };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  const quiet = [
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
  ];
  new AllExceptionsFilter().catch(err, host as never);
  for (const spy of quiet) spy.mockRestore();
  return { status, error: body.error };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("setStage — ownership and membership: one neutral 404 for every miss (no oracle)", () => {
  it.each([
    ["an unknown posting", UNKNOWN, APPLICANT],
    ["another payer's posting (with the same worker on it)", POSTING_B, APPLICANT],
    ["an owned posting, a worker who is not on its feed", POSTING_A, STRANGER],
    [
      "an owned agency job, a worker who applied only to the payer's OTHER posting",
      JOB_A,
      APPLICANT_2,
    ],
  ])("%s → the feeds' own 404, nothing written or emitted", async (_case, postingId, workerId) => {
    const d = make();
    const err = await rejection(
      d.svc.setStage(PAYER_A, postingId, workerId, "shortlist", CTX, NOW),
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(httpOutcome(err)).toEqual(
      httpOutcome(new NotFoundException(APPLICANT_NOT_FOUND)), // the feed's exact error object
    );
    expect(d.repo.rows.size).toBe(0);
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.spied.insertStage).not.toHaveBeenCalled();
    expect(d.spied.updateStage).not.toHaveBeenCalled();
  });

  it("the 404 body is the per-posting feed's ('Job not found')", () => {
    expect(APPLICANT_NOT_FOUND).toBe("Job not found");
  });

  it("ownership is decided by the SESSION payer the caller passes — B owns POSTING_B, A does not", async () => {
    const d = make();
    await expect(
      d.svc.setStage(PAYER_B, POSTING_B, APPLICANT, "shortlist", CTX, NOW),
    ).resolves.toMatchObject({ changed: true });
    expect(d.spied.findOwnedPostingKind).toHaveBeenCalledWith(POSTING_B, PAYER_B);
  });

  it("a foreign/unknown posting never opens the transaction (no membership read, no lock)", async () => {
    const d = make();
    await rejection(d.svc.setStage(PAYER_A, POSTING_B, APPLICANT, "shortlist", CTX, NOW));
    expect(d.spied.withTransaction).not.toHaveBeenCalled();
    expect(d.spied.isFeedApplicant).not.toHaveBeenCalled();
  });

  it("membership is checked for the RESOLVED kind (an agency job's applicant, not a posting's)", async () => {
    const d = make();
    await d.svc.setStage(PAYER_A, JOB_A, APPLICANT, "passed", CTX, NOW);
    expect(d.spied.isFeedApplicant).toHaveBeenCalledWith(
      { postingKind: "agency_job", postingId: JOB_A, workerId: APPLICANT },
      expect.anything(),
    );
  });
});

describe("setStage — a real change writes the row and emits ONE validated event", () => {
  it("first move (no row → shortlist): inserts, emits previous 'new', reports changed", async () => {
    const d = make();
    const out = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    expect(out).toEqual({
      postingId: POSTING_A,
      postingKind: "company_posting",
      workerId: APPLICANT,
      stage: "shortlist",
      previousStage: "new",
      changed: true,
    });
    expect([...d.repo.rows.values()]).toEqual([
      {
        postingKind: "company_posting",
        postingId: POSTING_A,
        workerId: APPLICANT,
        stage: "shortlist",
        actorPayerId: PAYER_A,
        updatedAt: NOW,
      },
    ]);
    expect(d.emit).toHaveBeenCalledOnce();
    expect(d.emitted[0]).toMatchObject({
      event_name: "payer.applicant_stage_changed",
      actor: { actor_type: "payer", actor_id: PAYER_A },
      subject: { subject_type: "worker", subject_id: APPLICANT },
      payload: {
        posting_kind: "company_posting",
        posting_id: POSTING_A,
        worker_id: APPLICANT,
        stage: "shortlist",
        previous_stage: "new",
      },
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
    // On the transaction, so the event commits iff the stage does.
    expect(d.emitted[0]!.tx).toBeDefined();
    // No idempotency key: a later identical transition is a real, separate change.
    expect(d.emitted[0]).not.toHaveProperty("idempotencyKey");
  });

  it("an agency job's applicant is stored and evented as `agency_job`", async () => {
    const d = make();
    const out = await d.svc.setStage(PAYER_A, JOB_A, APPLICANT, "passed", CTX, NOW);
    expect(out.postingKind).toBe("agency_job");
    expect(d.emitted[0]!.payload).toEqual({
      posting_kind: "agency_job",
      posting_id: JOB_A,
      worker_id: APPLICANT,
      stage: "passed",
      previous_stage: "new",
    });
  });

  it("a later move updates the row (by whichever payer made it) and reports what it replaced", async () => {
    const d = make();
    await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    const later = new Date("2026-10-07T11:00:00.000Z");
    const out = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "passed", CTX, later);
    expect(out).toMatchObject({ stage: "passed", previousStage: "shortlist", changed: true });
    expect(d.spied.updateStage).toHaveBeenCalledOnce();
    expect([...d.repo.rows.values()][0]).toMatchObject({ stage: "passed", updatedAt: later });
    expect(d.emitted.map((e) => (e.payload as { previous_stage: string }).previous_stage)).toEqual([
      "new",
      "shortlist",
    ]);
  });

  it("moving back to New STORES `new` (the row records who moved it back) and emits", async () => {
    const d = make();
    await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "passed", CTX, NOW);
    const out = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "new", CTX, NOW);
    expect(out).toMatchObject({ stage: "new", previousStage: "passed", changed: true });
    expect([...d.repo.rows.values()][0]!.stage).toBe("new");
    expect(d.emit).toHaveBeenCalledTimes(2);
  });

  it("the same transition again after a round trip is a NEW event (no transition dedupe)", async () => {
    const d = make();
    for (const stage of ["shortlist", "new", "shortlist"] as const) {
      await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, stage, CTX, NOW);
    }
    expect(d.emit).toHaveBeenCalledTimes(3);
  });
});

describe("setStage — idempotent: the stage already held writes nothing and emits nothing", () => {
  it("`new` for an applicant nobody moved: no row created, no event, changed false", async () => {
    const d = make();
    const out = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "new", CTX, NOW);
    expect(out).toEqual({
      postingId: POSTING_A,
      postingKind: "company_posting",
      workerId: APPLICANT,
      stage: "new",
      previousStage: "new",
      changed: false,
    });
    expect(d.repo.rows.size).toBe(0);
    expect(d.spied.insertStage).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("a retried move (same stage twice): the second is a 200 no-op with the same body but `changed`", async () => {
    const d = make();
    const first = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    const retry = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    expect(retry).toEqual({ ...first, previousStage: "shortlist", changed: false });
    expect(d.spied.updateStage).not.toHaveBeenCalled();
    expect(d.emit).toHaveBeenCalledOnce();
  });

  it("membership is still enforced on a no-op (a stranger's `new` is a 404, not a 200)", async () => {
    const d = make();
    const err = await rejection(d.svc.setStage(PAYER_A, POSTING_A, STRANGER, "new", CTX, NOW));
    expect(err).toBeInstanceOf(NotFoundException);
  });
});

describe("setStage — concurrency: two FIRST moves cannot both insert", () => {
  it("losing the insert race re-reads the winner's stage and continues as an update from it", async () => {
    const d = make();
    // The winner committed `passed` between our lock (no row) and our insert.
    let first = true;
    d.spied.lockStage.mockImplementation(async () => {
      if (first) {
        first = false;
        return null;
      }
      return "passed";
    });
    d.spied.insertStage.mockResolvedValueOnce(false);
    const out = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    expect(out).toMatchObject({ stage: "shortlist", previousStage: "passed", changed: true });
    expect(d.spied.updateStage).toHaveBeenCalledOnce();
    expect((d.emitted[0]!.payload as { previous_stage: string }).previous_stage).toBe("passed");
  });

  it("…and when the winner already stored the SAME stage, ours is the no-op", async () => {
    const d = make();
    let first = true;
    d.spied.lockStage.mockImplementation(async () => {
      if (first) {
        first = false;
        return null;
      }
      return "shortlist";
    });
    d.spied.insertStage.mockResolvedValueOnce(false);
    const out = await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    expect(out).toMatchObject({ previousStage: "shortlist", changed: false });
    expect(d.spied.updateStage).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });
});

describe("setStage — fail closed", () => {
  it("an emit failure propagates (the transaction rolls the stage back with it)", async () => {
    const d = make();
    d.emit.mockRejectedValueOnce(new Error("events insert failed"));
    await expect(
      d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW),
    ).rejects.toThrow("events insert failed");
  });

  it("a read error is never folded into the 404", async () => {
    const d = make();
    d.spied.findOwnedPostingKind.mockRejectedValueOnce(new Error("connection reset"));
    const err = await rejection(d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "passed", CTX, NOW));
    expect(err).not.toBeInstanceOf(NotFoundException);
    expect(httpOutcome(err).status).toBe(500);
  });
});

describe("flag OFF — the route's last line of defence, and no table is ever named", () => {
  it("setStage is a 404 and touches no repository method", async () => {
    const svc = stagesOff(); // its repository throws STAGES_TABLE_READ_WHILE_OFF on any call
    const err = await rejection(svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX));
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).not.toContain(STAGES_TABLE_READ_WHILE_OFF);
  });

  it("stagesForOwnedPosting answers null and touches no repository method", async () => {
    await expect(stagesOff().stagesForOwnedPosting(POSTING_A, KEY_A)).resolves.toBeNull();
  });

  it("`enabled` is true only for a literal true", () => {
    expect(make({ enabled: false }).svc.enabled).toBe(false);
    expect(make({ enabled: true }).svc.enabled).toBe(true);
  });
});

describe("stagesForOwnedPosting — the per-posting feed's read", () => {
  it("returns the owned posting's board under its kind; the other kind is empty", async () => {
    const d = make();
    await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    await d.svc.setStage(PAYER_A, POSTING_A, APPLICANT_2, "passed", CTX, NOW);
    const board = await d.svc.stagesForOwnedPosting(POSTING_A, KEY_A);
    expect(board).not.toBeNull();
    expect([...board!.company_posting]).toEqual([
      [APPLICANT, "shortlist"],
      [APPLICANT_2, "passed"],
    ]);
    expect(board!.agency_job.size).toBe(0);
  });

  it("another payer's posting reads as an empty board — its board is never even read", async () => {
    const d = make();
    await d.svc.setStage(PAYER_B, POSTING_B, APPLICANT, "shortlist", CTX, NOW);
    const board = await d.svc.stagesForOwnedPosting(POSTING_B, KEY_A);
    expect(board!.company_posting.size).toBe(0);
    expect(board!.agency_job.size).toBe(0);
    // The ownership chokepoint said "not yours", so the stages table was not touched (ADR-0053 §4).
    expect(d.spied.findOwnedPostingKind).toHaveBeenCalledWith(POSTING_B, PAYER_A);
    expect(d.spied.listPostingStages).not.toHaveBeenCalled();
  });

  it("ownership FIRST through the chokepoint, then the board by the RESOLVED (kind, id) only", async () => {
    const d = make();
    await d.svc.setStage(PAYER_A, JOB_A, APPLICANT, "passed", CTX, NOW);
    // A row of the OTHER kind under the same id must not be read as this posting's board.
    d.repo.rows.set(`company_posting|${JOB_A}|${APPLICANT_2}`, {
      postingKind: "company_posting",
      postingId: JOB_A,
      workerId: APPLICANT_2,
      stage: "shortlist",
      actorPayerId: PAYER_B,
      updatedAt: NOW,
    });
    d.spied.findOwnedPostingKind.mockClear();
    const board = await d.svc.stagesForOwnedPosting(JOB_A, KEY_A);
    expect([...board!.agency_job]).toEqual([[APPLICANT, "passed"]]);
    expect(board!.company_posting.size).toBe(0);
    expect(d.spied.findOwnedPostingKind).toHaveBeenCalledWith(JOB_A, PAYER_A);
    expect(d.spied.listPostingStages).toHaveBeenCalledWith("agency_job", JOB_A);
    expect(d.spied.findOwnedPostingKind.mock.invocationCallOrder[0]!).toBeLessThan(
      d.spied.listPostingStages.mock.invocationCallOrder.at(-1)!,
    );
  });
});

describe("readStoredStage / withStages", () => {
  it("no row is `new`; a known stage is itself", () => {
    expect(readStoredStage(null)).toBe("new");
    expect(readStoredStage(undefined)).toBe("new");
    for (const s of ["new", "shortlist", "passed"] as const) expect(readStoredStage(s)).toBe(s);
  });

  it("a stage this build does not know (DB ahead of code) reads as `new`, with a warning", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(readStoredStage("hired")).toBe("new");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("annotates every row, `new` where the board holds nothing, and changes nothing else", () => {
    const rows = [
      { workerId: APPLICANT, rank: 1 },
      { workerId: APPLICANT_2, rank: 2 },
    ];
    expect(withStages(rows, new Map([[APPLICANT_2, "passed" as const]]))).toEqual([
      { workerId: APPLICANT, rank: 1, stage: "new" },
      { workerId: APPLICANT_2, rank: 2, stage: "passed" },
    ]);
    expect(rows[0]).not.toHaveProperty("stage"); // no mutation of the input rows
  });
});

describe("ADR-0053 P2a — the saved board follows the TENANT; the row and the event name the LOGIN", () => {
  const MEMBER = "cccccccc-0000-4000-8000-00000000000c";
  const TEAM = [{ anchor: PAYER_A, members: [MEMBER] }];
  const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;

  it("on: a teammate moves an applicant on the anchor's posting — ownership on the anchor's key, actor_payer_id and the event actor = the login", async () => {
    const d = make({ tenancy: resolverOver(ON, TEAM) });
    const out = await d.svc.setStage(MEMBER, POSTING_A, APPLICANT, "shortlist", CTX, NOW);
    expect(out).toMatchObject({
      postingKind: "company_posting",
      stage: "shortlist",
      changed: true,
    });
    expect(d.spied.findOwnedPostingKind).toHaveBeenCalledWith(POSTING_A, PAYER_A);
    expect([...d.repo.rows.values()]).toEqual([
      expect.objectContaining({ postingId: POSTING_A, stage: "shortlist", actorPayerId: MEMBER }),
    ]);
    expect(d.emitted).toHaveLength(1);
    expect(d.emitted[0]!.actor).toEqual({ actor_type: "payer", actor_id: MEMBER });
    // The anchor's board shows the teammate's move (one board per org).
    const board = await d.svc.stagesForOwnedPosting(POSTING_A, KEY_A);
    expect([...board!.company_posting]).toEqual([[APPLICANT, "shortlist"]]);
  });

  it("on: an outsider gets the feeds' own 404 on the org's posting, and nothing is written", async () => {
    const d = make({ tenancy: resolverOver(ON, TEAM) });
    const err = await rejection(d.svc.setStage(PAYER_B, POSTING_A, APPLICANT, "passed", CTX, NOW));
    expect(httpOutcome(err)).toEqual(httpOutcome(new NotFoundException(APPLICANT_NOT_FOUND)));
    expect(d.repo.rows.size).toBe(0);
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("off (the default): the SAME teammate gets the 404 on the anchor's posting — today's behaviour", async () => {
    const d = make({ tenancy: defaultModeResolver(TEAM) });
    const err = await rejection(d.svc.setStage(MEMBER, POSTING_A, APPLICANT, "passed", CTX, NOW));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(d.spied.findOwnedPostingKind).toHaveBeenCalledWith(POSTING_A, MEMBER);
    expect(d.repo.rows.size).toBe(0);
  });

  it("flag off answers before any tenancy is resolved (no membership read while the board is dark)", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const resolve = vi.spyOn(tenancy, "resolve");
    const d = make({ enabled: false, tenancy });
    await rejection(d.svc.setStage(MEMBER, POSTING_A, APPLICANT, "passed", CTX, NOW));
    expect(resolve).not.toHaveBeenCalled();
  });
});
