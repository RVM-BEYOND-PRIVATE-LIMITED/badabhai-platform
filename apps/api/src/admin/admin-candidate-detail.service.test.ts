import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import type { LiveCorrection } from "../profiles/effective-facts.service";
import { AdminCandidateDetailService } from "./admin-candidate-detail.service";
import {
  ADMIN_CANDIDATE_RECENT_APPLICATIONS,
  ADMIN_CANDIDATE_RESUME_VERSIONS_MAX,
} from "./admin-candidate-detail.dto";
import {
  candidateInputs,
  FIXTURE_ADMIN_ID,
  FIXTURE_WORKER_ID,
} from "./testing/candidate-detail-fixtures";

const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: FIXTURE_ADMIN_ID, role, sid: "s" });

type CorrectionFactKey =
  | "skills"
  | "work_history"
  | "education"
  | "certifications"
  | "training"
  | "languages"
  | "work_types"
  | "documents_ready";

const STORED_CORRECTION_VALUES: Record<CorrectionFactKey, unknown> = {
  skills: ["skill_mig_welding"],
  work_history: { employments: [] },
  education: [],
  certifications: [],
  training: [],
  languages: [],
  work_types: ["contract"],
  documents_ready: ["aadhaar"],
};

/**
 * A service over recording fakes. Every dependency call is appended to `order`, so a test can
 * assert WHAT happened and in WHICH order — the audit-before-read property is an ordering claim.
 */
function build(
  opts: {
    core?: boolean;
    names?: Map<string, string | null> | null;
    emitFails?: boolean;
    corrections?: LiveCorrection[];
    stored?: Partial<Record<CorrectionFactKey, unknown>>;
    skillsThrow?: boolean;
  } = {},
) {
  const fx = candidateInputs();
  const order: string[] = [];
  const rec = <T>(name: string, value: T) =>
    vi.fn(async () => {
      order.push(name);
      return value;
    });

  const repo = {
    findCore: rec("repo.findCore", opts.core === false ? undefined : fx.core),
    currentJobDomain: rec("repo.currentJobDomain", fx.jobDomain),
    attributeProvenance: rec("repo.attributeProvenance", fx.provenance),
    employment: rec("repo.employment", fx.employment),
    matchSkills: rec("repo.matchSkills", fx.matchSkills),
    industryTenure: rec("repo.industryTenure", fx.tenure),
    resumeVersions: rec("repo.resumeVersions", fx.resumes),
    account: rec("repo.account", fx.account),
  };
  const workers = { latestProfile: rec("workers.latestProfile", fx.profile) };
  const attributes = {
    loadTradeSheet: rec("attributes.loadTradeSheet", {
      ...fx.tradeSheet,
      polishedAttributes: {},
      declinedAttributes: new Set(),
    }),
  };
  const qualifications = { loadForResume: rec("qualifications.loadForResume", fx.qualifications) };
  const languages = { loadForResume: rec("languages.loadForResume", fx.languages) };
  const occupations = { loadForWorker: rec("occupations.loadForWorker", fx.occupations) };
  const candidateSearch = {
    findCardRow: rec("candidateSearch.findCardRow", fx.card.row),
    listWantedRoles: rec("candidateSearch.listWantedRoles", fx.card.wantedRoles),
  };
  const workerSkills = {
    listStatedTradeLevels: rec("workerSkills.listStatedTradeLevels", fx.card.tradeLevels),
  };
  const entities = { listApplications: rec("entities.listApplications", fx.recentApplications) };
  const identity = {
    resolve: rec(
      "identity.resolve",
      opts.names === undefined ? new Map([[FIXTURE_WORKER_ID, "Test Worker"]]) : opts.names,
    ),
  };
  const events = {
    emit: vi.fn(async () => {
      order.push("events.emit");
      if (opts.emitFails) throw new Error("events insert failed");
      return {};
    }),
  };
  const db = { marker: "database" };
  const correctionFacts = {
    readPrevious: vi.fn(
      async (_db: unknown, _workerId: string, factKey: CorrectionFactKey): Promise<unknown> => {
        order.push(`correctionFacts.readPrevious.${factKey}`);
        if (factKey === "skills" && opts.skillsThrow) {
          throw new BadRequestException("Worker has no profile to correct yet");
        }
        return opts.stored?.[factKey] ?? STORED_CORRECTION_VALUES[factKey];
      },
    ),
  };
  const effectiveFacts = {
    liveFor: rec("effectiveFacts.liveFor", opts.corrections ?? []),
  };

  const service = new AdminCandidateDetailService(
    repo as never,
    workers as never,
    attributes as never,
    qualifications as never,
    languages as never,
    occupations as never,
    candidateSearch as never,
    workerSkills as never,
    entities as never,
    identity as never,
    events as never,
    effectiveFacts as never,
    db as never,
    correctionFacts as never,
  );
  const fakes = {
    repo,
    workers,
    attributes,
    qualifications,
    languages,
    occupations,
    candidateSearch,
    workerSkills,
    entities,
    identity,
  };
  return {
    service,
    order,
    events,
    identity,
    entities,
    repo,
    fakes,
    correctionFacts,
    effectiveFacts,
    db,
  };
}

describe("AdminCandidateDetailService.getCandidate", () => {
  it("unknown id → the neutral 404, and NOTHING else happens (no audit, no name, no read)", async () => {
    const { service, order } = build({ core: false });
    await expect(
      service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX)).rejects.toThrow(
      "Worker not found",
    );
    expect(new Set(order)).toEqual(new Set(["repo.findCore"]));
  });

  it("emits admin.candidate_viewed AFTER the 404 check and BEFORE the name layer and every data read", async () => {
    const { service, order } = build();
    await service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX);
    expect(order[0]).toBe("repo.findCore");
    expect(order[1]).toBe("events.emit");
    // Position 1 is the emit, so every name decrypt and every data read comes after it.
    expect(order.indexOf("identity.resolve")).toBeGreaterThan(1);
    expect(order.indexOf("workers.latestProfile")).toBeGreaterThan(1);
    expect(order.filter((c) => c === "events.emit")).toHaveLength(1);
    expect(order.length).toBeGreaterThan(15);
  });

  it("the audit payload is the two opaque ids, actor = session admin, subject = the worker", async () => {
    const { service, events } = build();
    await service.getCandidate(admin("ops_admin"), FIXTURE_WORKER_ID, CTX);
    expect(events.emit).toHaveBeenCalledWith({
      event_name: "admin.candidate_viewed",
      actor: { actor_type: "admin", actor_id: FIXTURE_ADMIN_ID },
      subject: { subject_type: "worker", subject_id: FIXTURE_WORKER_ID },
      payload: { admin_id: FIXTURE_ADMIN_ID, worker_id: FIXTURE_WORKER_ID },
      correlationId: "corr-1",
      requestId: "req-1",
    });
  });

  it("a FAILED emit fails the request closed: no name resolved, no data read, no record returned", async () => {
    const { service, order } = build({ emitFails: true });
    await expect(
      service.getCandidate(admin("super_admin"), FIXTURE_WORKER_ID, CTX),
    ).rejects.toThrow("events insert failed");
    expect(order).toEqual(["repo.findCore", "events.emit"]);
  });

  it("names go through AdminIdentityService on the `workers` surface, as a detail read of this worker", async () => {
    const { service, identity } = build();
    const d = await service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX);
    expect(identity.resolve).toHaveBeenCalledWith(
      admin("support"),
      "workers",
      [FIXTURE_WORKER_ID],
      FIXTURE_WORKER_ID,
      CTX,
    );
    expect(d.identity.name.value).toBe("Test Worker");
    expect(d.identity.name_disclosed).toBe(true);
  });

  it("an ANALYST (the identity layer returns null) gets the full record with name null and no error", async () => {
    const { service } = build({ names: null });
    const d = await service.getCandidate(admin("analyst"), FIXTURE_WORKER_ID, CTX);
    expect(d.identity.name.value).toBeNull();
    expect(d.identity.name_disclosed).toBe(false);
    expect(d.location.current_city.value).toBe("Pune");
    expect(d.employer_card.in_search_pool).toBe(true);
  });

  it("#2728 — an ANALYST gets correction_values: null and triggers NO correction read", async () => {
    const { service, correctionFacts } = build({ names: null });
    const d = await service.getCandidate(admin("analyst"), FIXTURE_WORKER_ID, CTX);
    expect(d.correction_values).toBeNull();
    expect(correctionFacts.readPrevious).not.toHaveBeenCalled();
  });

  it("#2728 — the roles holding edit_candidates get the eight stored values, read in ONE wave", async () => {
    for (const role of ["super_admin", "ops_admin", "support"] as const) {
      const { service, correctionFacts, db } = build();
      const d = await service.getCandidate(admin(role), FIXTURE_WORKER_ID, CTX);
      expect(d.correction_values, role).toEqual({
        skills: ["skill_mig_welding"],
        work_history: { employments: [] },
        education: [],
        certifications: [],
        training: [],
        languages: [],
        work_types: ["contract"],
        documents_ready: ["aadhaar"],
      });
      expect(correctionFacts.readPrevious, role).toHaveBeenCalledTimes(8);
      expect(new Set(correctionFacts.readPrevious.mock.calls.map((c) => c[2]))).toEqual(
        new Set([
          "skills",
          "work_history",
          "education",
          "certifications",
          "training",
          "languages",
          "work_types",
          "documents_ready",
        ]),
      );
      for (const call of correctionFacts.readPrevious.mock.calls) {
        expect(call[0]).toBe(db);
        expect(call[1]).toBe(FIXTURE_WORKER_ID);
      }
    }
  });

  it("#2728 — a live correction overrides the stored value in the prefill block", async () => {
    const corrections: LiveCorrection[] = [
      {
        id: "f0f0f0f0-0000-4000-8000-000000000001",
        factKey: "skills",
        adminId: FIXTURE_ADMIN_ID,
        reasonCode: "worker_request",
        reasonText: "worker asked",
        createdAt: new Date("2026-11-01T10:00:00.000Z"),
        corrected: ["skill_new"],
      },
      {
        id: "f0f0f0f0-0000-4000-8000-000000000002",
        factKey: "work_types",
        adminId: FIXTURE_ADMIN_ID,
        reasonCode: "profile_correction",
        reasonText: "correcting the profile",
        createdAt: new Date("2026-11-01T10:00:00.000Z"),
        corrected: ["permanent"],
      },
    ];
    const { service } = build({ corrections });
    const d = await service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX);
    expect(d.correction_values?.skills).toEqual(["skill_new"]);
    expect(d.correction_values?.work_types).toEqual(["permanent"]);
    expect(d.correction_values?.documents_ready).toEqual(["aadhaar"]);
  });

  it("#2728 — a worker with no profile yet gets an empty skills prefill, not a refused record", async () => {
    const { service } = build({ skillsThrow: true });
    const d = await service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX);
    expect(d.correction_values?.skills).toEqual([]);
    expect(d.correction_values?.work_types).toEqual(["contract"]);
  });

  it("every dependency is read EXACTLY ONCE — a fixed number of statements per worker, never per row", async () => {
    const { service, fakes } = build();
    await service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX);
    for (const [dep, methods] of Object.entries(fakes)) {
      for (const [name, fn] of Object.entries(
        methods as Record<string, ReturnType<typeof vi.fn>>,
      )) {
        expect(fn, `${dep}.${name}`).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("bounded lists: résumé versions and recent applications are capped at the contract's limits", async () => {
    const { service, repo, entities } = build();
    await service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX);
    expect(repo.resumeVersions).toHaveBeenCalledWith(
      FIXTURE_WORKER_ID,
      ADMIN_CANDIDATE_RESUME_VERSIONS_MAX,
    );
    expect(entities.listApplications).toHaveBeenCalledWith(
      { workerId: FIXTURE_WORKER_ID, action: "applied" },
      null,
      ADMIN_CANDIDATE_RECENT_APPLICATIONS,
    );
  });

  it("the response carries no phone, WhatsApp, download link or storage key anywhere", async () => {
    const { service } = build();
    const d = await service.getCandidate(admin("super_admin"), FIXTURE_WORKER_ID, CTX);
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(d);
    for (const k of keys)
      expect(k).not.toMatch(/phone|whatsapp|download|storage_key|url|reason_text/i);
  });

  it("a mapped value the contract does not name fails closed at the strict parse", async () => {
    const { service, repo } = build();
    // A core row whose status is not a string cannot satisfy the contract: the parse throws.
    repo.findCore.mockResolvedValueOnce({
      ...candidateInputs().core,
      status: 42 as unknown as string,
    });
    await expect(service.getCandidate(admin("support"), FIXTURE_WORKER_ID, CTX)).rejects.toThrow();
  });
});
