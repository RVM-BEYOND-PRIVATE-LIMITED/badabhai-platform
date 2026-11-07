import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
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

/**
 * A service over recording fakes. Every dependency call is appended to `order`, so a test can
 * assert WHAT happened and in WHICH order — the audit-before-read property is an ordering claim.
 */
function build(
  opts: {
    core?: boolean;
    names?: Map<string, string | null> | null;
    emitFails?: boolean;
    certs?: readonly {
      name: string;
      issuer: string | null;
      year: number | null;
      licence_number: string | null;
      licence_expiry: string | null;
    }[];
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
  // #2728 — only the licence-prefill test opts into the gated decrypt; every other build leaves
  // the optional db/correctionFacts out, so the mapper keeps the display rows with null licences.
  const correctionFacts =
    opts.certs === undefined
      ? undefined
      : {
          readPrevious: vi.fn(async () => {
            order.push("correctionFacts.readPrevious");
            return opts.certs;
          }),
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
    undefined,
    opts.certs === undefined ? undefined : ({} as never),
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
  return { service, order, events, identity, entities, repo, correctionFacts, fakes };
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

  it("prefills certificate licence fields only for an edit_candidates role (#2728)", async () => {
    const licence = {
      name: "Welding safety",
      issuer: "ITI",
      year: 2020,
      licence_number: "WB-1234",
      licence_expiry: "2030-01-01",
    };
    const editor = build({ certs: [licence] });
    const editorDetail = await editor.service.getCandidate(
      admin("support"),
      FIXTURE_WORKER_ID,
      CTX,
    );
    expect(editor.correctionFacts!.readPrevious).toHaveBeenCalledWith(
      expect.anything(),
      FIXTURE_WORKER_ID,
      "certifications",
    );
    expect(editorDetail.editable.certifications?.[0]?.licence_number).toBe("WB-1234");
    expect(editorDetail.editable.certifications?.[0]?.licence_expiry).toBe("2030-01-01");

    const analyst = build({ certs: [licence] });
    const analystDetail = await analyst.service.getCandidate(
      admin("analyst"),
      FIXTURE_WORKER_ID,
      CTX,
    );
    expect(analyst.correctionFacts!.readPrevious).not.toHaveBeenCalled();
    // The base fixture has no certificates, so the analyst gets the empty display list — and
    // crucially the decrypt seam was never called (the mapper test pins the null fields for a
    // non-editor row).
    expect(analystDetail.editable.certifications).toEqual([]);
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
