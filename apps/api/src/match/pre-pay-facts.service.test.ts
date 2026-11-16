import { describe, expect, it, vi } from "vitest";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { EffectiveFactsService } from "../profiles/effective-facts.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PRE_PAY_FACT_KEYS } from "./pre-pay-facts";
import type {
  ActiveInstituteLinkRow,
  PrePayFactsRawRow,
  PrePayFactsRepository,
} from "./pre-pay-facts.repository";
import { PrePayFactsService } from "./pre-pay-facts.service";
import type { WorkerActivityRepository } from "../worker-activity/worker-activity.repository";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";

/**
 * #2747 items 1, 4 and 9 — the label is on every row; the facts only while `applicant_facts` is
 * on for the company; the switch changes what is shown, never who is listed or in what order.
 */
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as TenantKey;
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-15T12:00:00.000Z");

function raw(workerId: string, over: Partial<PrePayFactsRawRow> = {}): PrePayFactsRawRow {
  return {
    workerId,
    fullNameEnc: null,
    workersCity: null,
    canonicalTradeId: null,
    canonicalRoleId: null,
    machineIds: null,
    salaryContainer: null,
    salaryExpectedMin: null,
    salaryExpectedMax: null,
    salaryPeriod: null,
    lastSeenAt: null,
    employerSharing: true,
    onBriefNotice: true,
    ...over,
  };
}

function setup(opts: {
  on: boolean;
  links?: ActiveInstituteLinkRow[];
  rows?: PrePayFactsRawRow[];
  decrypt?: (token: string) => string;
}) {
  const repo = {
    listActiveInstituteLinks: vi.fn(async () => opts.links ?? []),
    listForWorkers: vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => opts.rows?.find((r) => r.workerId === id) ?? raw(id)),
    ),
  };
  const rollout = { isEnabledFor: vi.fn(async () => opts.on) };
  const pii = { decrypt: vi.fn(opts.decrypt ?? ((t: string) => t.replace(/^enc:/, ""))) };
  const corrections = { resolveMany: vi.fn(async () => new Map()) };
  const svc = new PrePayFactsService(
    repo as unknown as PrePayFactsRepository,
    rollout as unknown as FeatureRolloutService,
    pii as unknown as PiiCryptoService,
    corrections as unknown as EffectiveFactsService,
  );
  return { svc, repo, rollout, pii, corrections };
}

describe("PrePayFactsService.decorate", () => {
  it("asks the rollout switch for THIS company's tenant key", async () => {
    const { svc, rollout } = setup({ on: false });
    await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(rollout.isEnabledFor).toHaveBeenCalledWith("applicant_facts", TENANT);
  });

  it("switch off: the label only — no fact key, no facts read, no name decrypted", async () => {
    const { svc, repo, pii } = setup({
      on: false,
      links: [{ workerId: W1, instituteCode: "rvm", course: "CNC", branch: "Pune" }],
    });
    const out = await svc.decorate([{ workerId: W1 }, { workerId: W2 }], TENANT, NOW);
    expect(out).toEqual([
      { workerId: W1, source: "rvm_student" },
      { workerId: W2, source: "badabhai_worker" },
    ]);
    for (const row of out) for (const key of PRE_PAY_FACT_KEYS) expect(row).not.toHaveProperty(key);
    expect(repo.listForWorkers).not.toHaveBeenCalled();
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it("labels a V1 row from its own instituteCode and, switched off, reads nothing", async () => {
    const { svc, repo } = setup({ on: false });
    const out = await svc.decorate(
      [
        { workerId: W1, instituteCode: "rvm" },
        { workerId: W2, instituteCode: null },
      ],
      TENANT,
      NOW,
    );
    expect(out.map((r) => r.source)).toEqual(["rvm_student", "badabhai_worker"]);
    expect(repo.listActiveInstituteLinks).not.toHaveBeenCalled();
  });

  it("switch on: every fact key on every row, null meaning not given", async () => {
    const { svc } = setup({
      on: true,
      rows: [
        raw(W1, { fullNameEnc: "enc:Ramesh Kumar", workersCity: "Pune", salaryExpectedMin: 24000 }),
      ],
    });
    const out = await svc.decorate([{ workerId: W1 }, { workerId: W2 }], TENANT, NOW);
    for (const row of out) for (const key of PRE_PAY_FACT_KEYS) expect(row).toHaveProperty(key);
    expect(out[0]).toMatchObject({
      source: "badabhai_worker",
      firstName: "Ramesh",
      area: "Pune",
      expectedSalary: "₹24,000 / month",
    });
    expect(out[1]).toMatchObject({ firstName: null, expectedSalary: null, area: null });
  });

  it("keeps the order and the count, and the row's own keys", async () => {
    const { svc } = setup({ on: true });
    const rows = [
      { workerId: W2, rank: 1 },
      { workerId: W1, rank: 2 },
      { workerId: W2, rank: 3 },
    ];
    const out = await svc.decorate(rows, TENANT, NOW);
    expect(out.map((r) => [r.workerId, r.rank])).toEqual([
      [W2, 1],
      [W1, 2],
      [W2, 3],
    ]);
  });

  it("an RVM applicant shows his course and his branch city", async () => {
    const { svc } = setup({
      on: true,
      links: [{ workerId: W1, instituteCode: "rvm", course: "Diploma in CNC", branch: "Nashik" }],
      rows: [raw(W1, { workersCity: "Mumbai" })],
    });
    const [out] = await svc.decorate([{ workerId: W1, instituteCode: "rvm" }], TENANT, NOW);
    expect(out).toMatchObject({
      source: "rvm_student",
      tradeLine: "Diploma in CNC",
      area: "Nashik",
    });
  });

  it("a name that does not decrypt is not given, and the log line names only the worker id", async () => {
    const { svc } = setup({
      on: true,
      rows: [raw(W1, { fullNameEnc: "enc:Sunita Devi" })],
      decrypt: () => {
        throw new Error("bad tag for Sunita Devi");
      },
    });
    const warn = vi.spyOn(
      (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
      "warn",
    );
    const [out] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(out!.firstName).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(W1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/Sunita|Devi|enc:/);
  });

  it('#2747 §3.8 — employer_sharing on the 2026-11-04 notice ("naam nahi dikhta"): every fact is not given', async () => {
    const { svc, pii } = setup({
      on: true,
      rows: [
        raw(W1, { fullNameEnc: "enc:Ramesh Kumar", workersCity: "Pune", onBriefNotice: false }),
      ],
    });
    const [out] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    for (const key of PRE_PAY_FACT_KEYS) expect(out).toHaveProperty(key, null);
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it("no live employer_sharing: every fact is not given, and his name is never decrypted", async () => {
    const { svc, pii } = setup({
      on: true,
      rows: [
        raw(W1, {
          fullNameEnc: "enc:Ramesh Kumar",
          workersCity: "Pune",
          salaryExpectedMin: 24000,
          employerSharing: false,
        }),
      ],
    });
    const [out] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    for (const key of PRE_PAY_FACT_KEYS) expect(out).toHaveProperty(key, null);
    expect(out!.source).toBe("badabhai_worker");
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it("an actively linked RVM student is decided by the institute rule, not his BadaBhai consent", async () => {
    const { svc } = setup({
      on: true,
      links: [{ workerId: W1, instituteCode: "rvm", course: "Diploma in CNC", branch: "Pune" }],
      rows: [raw(W1, { fullNameEnc: "enc:Sameer Patil", employerSharing: false })],
    });
    const [out] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(out).toMatchObject({
      source: "rvm_student",
      firstName: "Sameer",
      tradeLine: "Diploma in CNC",
    });
  });

  it("an empty page reads nothing and asks no switch", async () => {
    const { svc, rollout, repo } = setup({ on: true });
    expect(await svc.decorate([], TENANT, NOW)).toEqual([]);
    expect(rollout.isEnabledFor).not.toHaveBeenCalled();
    expect(repo.listActiveInstituteLinks).not.toHaveBeenCalled();
  });

  it("a facts read that fails fails the call (no half-decorated page)", async () => {
    const { svc, repo } = setup({ on: true });
    repo.listForWorkers.mockRejectedValueOnce(new Error("connection reset"));
    await expect(svc.decorate([{ workerId: W1 }], TENANT, NOW)).rejects.toThrow("connection reset");
  });
});

/**
 * #2753 items 4 and 7 — with WORKER_ACTIVITY_ENABLED on, every row carries `notRecentlyActive`
 * (whatever the facts switch or his consent say) and the pre-pay `lastActiveOn` is the one
 * last-active day; off, the key is absent and `worker_activity` is never read.
 */
describe("PrePayFactsService.decorate — the last-active day and its mark (#2753)", () => {
  // NOW is 2026-11-15 in India: 2026-08-16 is 91 days before it, 2026-08-17 is 90.
  const W3 = "33333333-3333-4333-8333-333333333333";

  function withActivity(opts: {
    activityOn: boolean;
    factsOn: boolean;
    days?: Map<string, string>;
    rows?: PrePayFactsRawRow[];
    thresholdDays?: number;
  }) {
    const base = setup({ on: opts.factsOn, rows: opts.rows });
    const activityRepo = {
      touch: vi.fn(),
      lastActiveDays: vi.fn(async () => opts.days ?? new Map<string, string>()),
    };
    const activity = new WorkerActivityService(
      activityRepo as unknown as WorkerActivityRepository,
      {
        WORKER_ACTIVITY_ENABLED: opts.activityOn,
        NOT_RECENTLY_ACTIVE_DAYS: opts.thresholdDays ?? 90,
      },
    );
    const svc = new PrePayFactsService(
      base.repo as unknown as PrePayFactsRepository,
      base.rollout as unknown as FeatureRolloutService,
      base.pii as unknown as PiiCryptoService,
      base.corrections as unknown as EffectiveFactsService,
      activity,
    );
    return { ...base, svc, activityRepo };
  }

  it("switch off: no `notRecentlyActive` key on any row, and worker_activity is never read", async () => {
    for (const factsOn of [false, true]) {
      const { svc, activityRepo } = withActivity({ activityOn: false, factsOn });
      const out = await svc.decorate([{ workerId: W1 }, { workerId: W2 }], TENANT, NOW);
      for (const row of out) expect(row).not.toHaveProperty("notRecentlyActive");
      expect(activityRepo.lastActiveDays).not.toHaveBeenCalled();
    }
  });

  it("switch off, facts off: byte-identical to today (the label only)", async () => {
    const { svc } = withActivity({ activityOn: false, factsOn: false });
    const out = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(out).toEqual([{ workerId: W1, source: "badabhai_worker" }]);
  });

  it("switch off, facts on: lastActiveOn is still the device sighting", async () => {
    const { svc } = withActivity({
      activityOn: false,
      factsOn: true,
      rows: [raw(W1, { lastSeenAt: "2026-11-10T20:00:00.000Z" })],
    });
    const [row] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(row?.lastActiveOn).toBe("2026-11-11");
  });

  it("switch on, facts OFF: the mark is on every row anyway (not a profile fact)", async () => {
    const { svc, activityRepo, repo } = withActivity({
      activityOn: true,
      factsOn: false,
      days: new Map([
        [W1, "2026-08-16"], // 91 days: marked
        [W2, "2026-08-17"], // 90 days: not marked
      ]),
    });
    const out = await svc.decorate(
      [{ workerId: W1 }, { workerId: W2 }, { workerId: W3 }],
      TENANT,
      NOW,
    );
    expect(out).toEqual([
      { workerId: W1, source: "badabhai_worker", notRecentlyActive: true },
      { workerId: W2, source: "badabhai_worker", notRecentlyActive: false },
      // Never seen: no day, not marked.
      { workerId: W3, source: "badabhai_worker", notRecentlyActive: false },
    ]);
    for (const row of out) for (const key of PRE_PAY_FACT_KEYS) expect(row).not.toHaveProperty(key);
    // ONE read for the whole page, never one per row; the facts read still does not run.
    expect(activityRepo.lastActiveDays).toHaveBeenCalledTimes(1);
    expect(activityRepo.lastActiveDays).toHaveBeenCalledWith([W1, W2, W3], NOW);
    expect(repo.listForWorkers).not.toHaveBeenCalled();
  });

  it("switch on, facts on: lastActiveOn is the unified day, and the mark agrees with it", async () => {
    const { svc } = withActivity({
      activityOn: true,
      factsOn: true,
      // The device says August; the table says he used the app last week.
      rows: [raw(W1, { lastSeenAt: "2026-08-01T10:00:00.000Z" })],
      days: new Map([[W1, "2026-11-08"]]),
    });
    const [row] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(row).toMatchObject({ lastActiveOn: "2026-11-08", notRecentlyActive: false });
    // The mark is the row's last key, after the facts.
    expect(Object.keys(row!).at(-1)).toBe("notRecentlyActive");
  });

  it("consent still decides the FACT, never the mark", async () => {
    const { svc } = withActivity({
      activityOn: true,
      factsOn: true,
      rows: [raw(W1, { employerSharing: false })],
      days: new Map([[W1, "2026-01-01"]]),
    });
    const [row] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(row).toMatchObject({ lastActiveOn: null, notRecentlyActive: true });
  });

  it("reads the custom NOT_RECENTLY_ACTIVE_DAYS", async () => {
    const { svc } = withActivity({
      activityOn: true,
      factsOn: false,
      thresholdDays: 30,
      days: new Map([[W1, "2026-10-15"]]), // 31 days before 2026-11-15
    });
    const [row] = await svc.decorate([{ workerId: W1 }], TENANT, NOW);
    expect(row?.notRecentlyActive).toBe(true);
  });

  it("keeps the order and the count: a mark, never a filter or a sort", async () => {
    const { svc } = withActivity({
      activityOn: true,
      factsOn: false,
      days: new Map([[W2, "2026-01-01"]]),
    });
    const out = await svc.decorate([{ workerId: W2 }, { workerId: W1 }], TENANT, NOW);
    expect(out.map((r) => r.workerId)).toEqual([W2, W1]);
  });
});
