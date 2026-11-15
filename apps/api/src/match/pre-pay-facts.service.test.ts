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
