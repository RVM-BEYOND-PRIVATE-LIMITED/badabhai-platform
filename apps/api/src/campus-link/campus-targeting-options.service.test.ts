import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@badabhai/db";

import type { EventsService } from "../events/events.service";
import type {
  CampusTargetingOptionsRepository,
  StoredTargetingOption,
} from "./campus-targeting-options.repository";
import {
  CampusTargetingOptionsService,
  planTargetingReplacement,
  type CampusTargetingOptionsList,
} from "./campus-targeting-options.service";

/**
 * #2746 PR 5 — the replacement rule (pure) and the service's transaction, with the repository and
 * the events faked. The statements (the upsert, the retirement, the advisory lock, "never a
 * delete") run against Postgres in `campus-review.db.test.ts`.
 */

const CALL = {
  ctx: { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "r" },
  callId: "cccccccc-0000-4000-8000-000000000001",
};

const stored = (
  over: Partial<StoredTargetingOption> & Pick<StoredTargetingOption, "kind" | "ref">,
) => ({
  label: `label ${over.ref}`,
  active: true,
  sortOrder: 0,
  ...over,
});

const STORED: StoredTargetingOption[] = [
  stored({ kind: "branch", ref: "1", label: "Faridabad", sortOrder: 0 }),
  stored({ kind: "branch", ref: "2", label: "Pune", sortOrder: 1 }),
  stored({ kind: "branch", ref: "3", label: "Ahmedabad", sortOrder: 2 }),
  stored({ kind: "branch", ref: "9", label: "Old branch", active: false, sortOrder: 9 }),
  stored({ kind: "course", ref: "cnc", label: "CNC Programming", sortOrder: 0 }),
];

const LIST: CampusTargetingOptionsList = {
  branches: [
    { id: 1, name: "Faridabad" }, // unchanged
    { id: 2, name: "Pune City" }, // relabelled
    { id: 9, name: "Old branch" }, // back from inactive
    { id: 4, name: "Lucknow" }, // new
  ],
  courses: [{ id: "cad", name: "CAD Design" }], // new; `cnc` leaves the list
};

describe("planTargetingReplacement", () => {
  it("adds new refs, updates changed or returning ones, retires the active ones not listed", () => {
    const plan = planTargetingReplacement(STORED, LIST);
    expect(plan.writes).toEqual([
      { kind: "branch", ref: "2", label: "Pune City", sortOrder: 1 },
      { kind: "branch", ref: "9", label: "Old branch", sortOrder: 2 },
      { kind: "branch", ref: "4", label: "Lucknow", sortOrder: 3 },
      { kind: "course", ref: "cad", label: "CAD Design", sortOrder: 0 },
    ]);
    // Branch 3 left the list; branch 9 is listed again; course `cnc` left the list.
    expect(plan.retire).toEqual({ branch: ["3"], course: ["cnc"] });
    expect(plan.counts).toEqual({
      branches: { listed: 4, added: 1, updated: 2, deactivated: 1 },
      courses: { listed: 1, added: 1, updated: 0, deactivated: 1 },
    });
  });

  it("takes the order from list position: a move is an update", () => {
    const plan = planTargetingReplacement(STORED, {
      branches: [
        { id: 2, name: "Pune" },
        { id: 1, name: "Faridabad" },
        { id: 3, name: "Ahmedabad" },
      ],
      courses: [{ id: "cnc", name: "CNC Programming" }],
    });
    expect(plan.writes).toEqual([
      { kind: "branch", ref: "2", label: "Pune", sortOrder: 0 },
      { kind: "branch", ref: "1", label: "Faridabad", sortOrder: 1 },
    ]);
    expect(plan.counts.branches).toEqual({ listed: 3, added: 0, updated: 2, deactivated: 0 });
  });

  it("the same list again plans nothing", () => {
    const plan = planTargetingReplacement(STORED, {
      branches: [
        { id: 1, name: "Faridabad" },
        { id: 2, name: "Pune" },
        { id: 3, name: "Ahmedabad" },
      ],
      courses: [{ id: "cnc", name: "CNC Programming" }],
    });
    expect(plan.writes).toEqual([]);
    expect(plan.retire).toEqual({ branch: [], course: [] });
  });

  it("an empty list retires every active option of the kind and leaves inactive ones alone", () => {
    const plan = planTargetingReplacement(STORED, { branches: [], courses: [] });
    expect(plan.retire).toEqual({ branch: ["1", "2", "3"], course: ["cnc"] });
    expect(plan.counts.branches.deactivated).toBe(3);
  });

  it("keys a branch by its id as text, the form rvm_targeting_options.ref stores", () => {
    const plan = planTargetingReplacement([], { branches: [{ id: 12, name: "X" }], courses: [] });
    expect(plan.writes[0]!.ref).toBe("12");
  });
});

function make(rows: StoredTargetingOption[] = STORED) {
  const tx = { tx: true } as unknown as Database;
  const calls: string[] = [];
  const repo = {
    withTransaction: vi.fn(async <T>(work: (t: Database) => Promise<T>) => work(tx)),
    lockForReplace: vi.fn(async () => {
      calls.push("lock");
    }),
    listAll: vi.fn(async () => {
      calls.push("list");
      return rows;
    }),
    upsert: vi.fn(async () => {
      calls.push("upsert");
    }),
    retire: vi.fn(async () => {
      calls.push("retire");
    }),
    writeAudit: vi.fn(async () => undefined),
  };
  const events = {
    emit: vi.fn(async () => ({ event_id: "eeeeeeee-0000-4000-8000-000000000002" })),
  };
  const service = new CampusTargetingOptionsService(
    repo as unknown as CampusTargetingOptionsRepository,
    events as unknown as EventsService,
  );
  return { service, repo, events, tx, calls };
}

describe("CampusTargetingOptionsService.replace", () => {
  it("locks, reads, upserts and retires in one transaction, and answers the counts", async () => {
    const { service, repo, tx, calls } = make();
    const counts = await service.replace(LIST, CALL);
    expect(calls).toEqual(["lock", "list", "upsert", "retire"]);
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(repo.upsert).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(repo.retire).toHaveBeenCalledWith(tx, { branch: ["3"], course: ["cnc"] });
    expect(counts.branches).toEqual({ listed: 4, added: 1, updated: 2, deactivated: 1 });
  });

  it("emits job_posting.rvm_targeting_options_set v1 with counts only, on the transaction", async () => {
    const { service, events, tx } = make();
    await service.replace(LIST, CALL);
    const emitted = (events.emit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(emitted).toMatchObject({
      event_name: "job_posting.rvm_targeting_options_set",
      subject: { subject_type: "job_posting", subject_id: null },
      tx,
    });
    expect(emitted.payload).toEqual({
      institute_code: "rvm",
      branches: { listed: 4, added: 1, updated: 2, deactivated: 1 },
      courses: { listed: 1, added: 1, updated: 0, deactivated: 1 },
    });
    // No ref and no label rides the spine.
    expect(JSON.stringify(emitted.payload)).not.toMatch(/Lucknow|CAD|cnc/);
  });

  it("writes the audit row under the guard's call id, with the counts and the event id", async () => {
    const { service, repo, tx } = make();
    await service.replace(LIST, CALL);
    expect(repo.writeAudit).toHaveBeenCalledWith(tx, CALL.callId, {
      institute_code: "rvm",
      branches: { listed: 4, added: 1, updated: 2, deactivated: 1 },
      courses: { listed: 1, added: 1, updated: 0, deactivated: 1 },
      event_id: "eeeeeeee-0000-4000-8000-000000000002",
    });
  });

  it("the same list again emits nothing and writes no audit row (idempotent by content)", async () => {
    const { service, events, repo } = make();
    const same: CampusTargetingOptionsList = {
      branches: [
        { id: 1, name: "Faridabad" },
        { id: 2, name: "Pune" },
        { id: 3, name: "Ahmedabad" },
      ],
      courses: [{ id: "cnc", name: "CNC Programming" }],
    };
    const counts = await service.replace(same, CALL);
    expect(counts.branches).toEqual({ listed: 3, added: 0, updated: 0, deactivated: 0 });
    expect(events.emit).not.toHaveBeenCalled();
    expect(repo.writeAudit).not.toHaveBeenCalled();
  });
});
