import { describe, expect, it } from "vitest";
import { AdminCandidateDetailSchema } from "./admin-candidate-detail.dto";
import { toCandidateDetail } from "./admin-candidate-detail.mapper";
import {
  candidateInputs,
  FIXTURE_ADMIN_ID,
  FIXTURE_WORKER_ID,
  profileFixture,
  prov,
} from "./testing/candidate-detail-fixtures";

/**
 * The pure #2560 mapper, group by group. The VALUES come from the employer-facing code paths
 * (pinned against them in `admin-candidate-detail.contract.test.ts`); these tests pin the grouping,
 * the provenance each field reports, and that every response satisfies the strict contract.
 */

describe("toCandidateDetail — the contract", () => {
  it("every built response satisfies the .strict() response schema", () => {
    expect(() =>
      AdminCandidateDetailSchema.parse(toCandidateDetail(candidateInputs())),
    ).not.toThrow();
    // ...including the emptiest worker: no profile, no attributes, nothing.
    const empty = toCandidateDetail(
      candidateInputs({
        profile: undefined,
        jobDomain: null,
        tradeSheet: { packId: null, attributes: {} },
        provenance: [],
        employment: [],
        matchSkills: [],
        tenure: [],
        card: { row: null, wantedRoles: [], tradeLevels: [] },
        resumes: { rows: [], total: 0 },
      }),
    );
    expect(() => AdminCandidateDetailSchema.parse(empty)).not.toThrow();
  });

  it("every field's correction is null until #2561", () => {
    const corrections: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if ("correction" in obj && "source" in obj && "value" in obj)
          corrections.push(obj.correction);
        Object.values(obj).forEach(walk);
      }
    };
    walk(toCandidateDetail(candidateInputs()));
    expect(corrections.length).toBeGreaterThan(40);
    expect(new Set(corrections)).toEqual(new Set([null]));
  });

  it("an empty value always reports `none`, whatever writer the input named", () => {
    const d = toCandidateDetail(
      candidateInputs({
        tradeSheet: { packId: null, attributes: {} },
        provenance: [],
        employment: [],
      }),
    );
    expect(d.location.preferred_locations).toEqual({ value: [], source: "none", correction: null });
    expect(d.work_history.source).toBe("none");
    expect(d.preferences.shift.source).toBe("none");
  });
});

describe("identity", () => {
  it("a disclosed name is shown; its writer is unknown (worker AND ops routes write the column)", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.identity.name).toEqual({ value: "Test Worker", source: "unknown", correction: null });
    expect(d.identity.name_disclosed).toBe(true);
  });

  it("NOT disclosed (an analyst, an exhausted budget) → value null, name_disclosed false", () => {
    const d = toCandidateDetail(
      candidateInputs({ name: { disclosed: false, value: "must not leak" } }),
    );
    expect(d.identity.name.value).toBeNull();
    expect(d.identity.name_disclosed).toBe(false);
  });

  it("disclosed but none on record → null with source none; photo present/absent and the worker's setting", () => {
    const d = toCandidateDetail(candidateInputs({ name: { disclosed: true, value: null } }));
    expect(d.identity.name).toEqual({ value: null, source: "none", correction: null });
    expect(d.identity.has_photo).toEqual({ value: true, source: "worker_edit", correction: null });
    expect(d.identity.resume_show_photo.value).toBe(true);
  });
});

describe("location", () => {
  it("current city: the worker's own column wins over the extraction (owner ruling 2026-09-05)", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.location.current_city).toEqual({
      value: "Pune",
      source: "worker_edit",
      correction: null,
    });
    expect(d.location.current_state.value).toBe("Maharashtra");
  });

  it("no own city → the profile's, with the profile road as the source", () => {
    const base = candidateInputs();
    const d = toCandidateDetail({ ...base, core: { ...base.core, currentCity: null } });
    expect(d.location.current_city).toEqual({
      value: "Chakan",
      source: "interview",
      correction: null,
    });
  });

  it("preferred locations are the résumé's attribute, with that attribute's writer", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.location.preferred_locations).toEqual({
      value: ["Pune", "Chakan"],
      source: "worker_edit",
      correction: null,
    });
  });
});

describe("trade & role", () => {
  it("ids + display name from the summary, sourced to the profile road; the job domain is the matcher's", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.trade.display_name).toEqual({
      value: "Welder",
      source: "interview",
      correction: null,
    });
    expect(d.trade.canonical_role_id.source).toBe("none");
    expect(d.trade.job_domain).toEqual({
      value: { id: "jd_welder", label: "Welder" },
      source: "derived",
      correction: null,
    });
  });

  it("a CV-seeded profile reports resume_import; secondary roles are labelled and `unknown`", () => {
    const d = toCandidateDetail(
      candidateInputs({
        profile: profileFixture({ seededFromImportId: "imp-1" }),
        occupations: ["role_unknown_x"],
      }),
    );
    expect(d.trade.display_name.source).toBe("resume_import");
    expect(d.trade.secondary_roles).toEqual({
      value: [{ id: "role_unknown_x", label: "role_unknown_x" }],
      source: "unknown",
      correction: null,
    });
  });
});

describe("employer card", () => {
  it("in the pool: the search card's own values, derived; the city canonicalised from his column", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.employer_card.in_search_pool).toBe(true);
    expect(d.employer_card.role.value?.id).toBe("mskill_tig_welder");
    expect(d.employer_card.role.source).toBe("derived");
    expect(d.employer_card.role_months.value).toBe(48);
    expect(d.employer_card.city).toEqual({
      value: "Pune",
      source: "worker_edit",
      correction: null,
    });
    expect(d.employer_card.is_sample).toBe(false);
  });

  it("not in the pool: every value empty — an employer does not see him at all", () => {
    const d = toCandidateDetail(
      candidateInputs({ card: { row: null, wantedRoles: [], tradeLevels: [] } }),
    );
    expect(d.employer_card.in_search_pool).toBe(false);
    expect(d.employer_card.role).toEqual({ value: null, source: "none", correction: null });
    expect(d.employer_card.city.value).toBeNull();
  });
});

describe("skills & experience", () => {
  it("profile skills/machines/years with the road's source; match rows with their own sources", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.skills.skills).toEqual({
      value: ["MIG Welding", "Arc Welding"],
      source: "interview",
      correction: null,
    });
    expect(d.skills.machines.value).toEqual(["VMC"]);
    expect(d.skills.match_skills.map((s) => [s.skill_id, s.wants, s.source])).toEqual([
      ["mskill_tig_welder", true, "derived"],
      ["mskill_cnc_turner", false, "worker_edit"],
    ]);
    expect(d.experience.total_years).toEqual({ value: 4, source: "interview", correction: null });
    expect(d.experience.industry_tenure.source).toBe("derived");
    expect(d.experience.industry_tenure.value[0]?.calendar_months).toBe(50);
  });
});

describe("work history, education, languages", () => {
  it("work history rows without the employer name, from the worker's own writer", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.work_history.source).toBe("worker_edit");
    expect(d.work_history.value[0]).toEqual({
      employer_city: "Pune",
      employer_state: "Maharashtra",
      start_ym: "2021-04",
      end_ym: null,
      duration_stated: true,
      roles: [
        {
          role_label: "Welder",
          start_ym: "2021-04",
          end_ym: null,
          work_done: "MIG welding of frames",
          work_done_polished: null,
          work_done_polish_declined: false,
        },
      ],
    });
    expect(JSON.stringify(d.work_history)).not.toMatch(/employer_name/);
  });

  it("languages: the rows' lines win (worker_edit); with no rows, the attribute and ITS writer", () => {
    const withRows = toCandidateDetail(
      candidateInputs({
        languages: [{ language: "hindi", canSpeak: true, canRead: true, canWrite: false }],
      }),
    );
    expect(withRows.languages.source).toBe("worker_edit");
    expect(withRows.languages.value.length).toBe(1);
    const fromAttribute = toCandidateDetail(candidateInputs());
    expect(fromAttribute.languages).toEqual({
      value: ["Hindi", "Marathi"],
      source: "interview",
      correction: null,
    });
  });

  it("education: rows → worker_edit, training → unknown, the summary labels → the profile road", () => {
    const d = toCandidateDetail(
      candidateInputs({
        qualifications: {
          certificates: [{ name: "Welding safety", issuer: null, year: 2020 }],
          educations: [],
          trainings: [{ name: "MIG course", provider: null, year: 2019 }],
        },
      }),
    );
    expect(d.education.certifications.source).toBe("worker_edit");
    expect(d.education.certifications.value.length).toBe(1);
    expect(d.education.training.source).toBe("unknown");
    expect(d.education.education_level).toEqual({
      value: "iti",
      source: "interview",
      correction: null,
    });
  });
});

describe("salary & preferences", () => {
  it("no container figure → the attribute band with its writer, period stated", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.salary.band).toEqual({
      value: { low: 18000, high: 22000 },
      source: "worker_edit",
      correction: null,
    });
    expect(d.salary.period).toEqual({ value: "month", source: "worker_edit", correction: null });
    expect(d.salary.open_top_chip).toBe(false);
  });

  it("a container figure wins outright, sourced to the profile road", () => {
    const d = toCandidateDetail(
      candidateInputs({
        profile: profileFixture({ salaryExpectation: { amount_min: 25000, amount_max: null } }),
      }),
    );
    expect(d.salary.band).toEqual({
      value: { low: 25000, high: null },
      source: "interview",
      correction: null,
    });
  });

  it("the open-top chip is reported, and an unanswered period is the derived default", () => {
    const base = candidateInputs();
    const d = toCandidateDetail({
      ...base,
      tradeSheet: { packId: null, attributes: { salary_expected_max: 100_000 } },
      provenance: [prov("salary_expected_max")],
    });
    expect(d.salary.open_top_chip).toBe(true);
    expect(d.salary.period).toEqual({ value: "month", source: "derived", correction: null });
  });

  it("each preference reports its own attribute's writer", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.preferences.shift).toEqual({
      value: "Night shift",
      source: "interview",
      correction: null,
    });
    expect(d.preferences.job_type).toEqual({
      value: "Permanent",
      source: "form",
      correction: null,
    });
    expect(d.preferences.work_types).toEqual({
      value: ["Contract"],
      source: "worker_edit",
      correction: null,
    });
    expect(d.preferences.documents).toEqual({
      value: ["Aadhaar", "PAN"],
      source: "resume_import",
      correction: null,
    });
    expect(d.preferences.commute_max_km).toEqual({
      value: 0,
      source: "worker_edit",
      correction: null,
    });
    expect(d.preferences.availability.value.status).toBe("within_week");
    expect(d.preferences.availability.value.status_label).toBe("Within a week");
    expect(d.preferences.availability.source).toBe("worker_edit");
  });
});

describe("résumé, account, activity", () => {
  it("résumé versions carry no link or key, only has_pdf", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.resume.versions[0]).toEqual({
      resume_id: "d0d0d0d0-0000-4000-8000-000000000002",
      version: 2,
      generation_trigger: "chat_edit",
      generation_source: "chat",
      render_status: "rendered",
      template_id: "bb_trade",
      has_pdf: true,
      generated_at: "2026-11-01T10:00:00.000Z",
      rendered_at: "2026-11-01T10:00:00.000Z",
    });
    expect(d.resume.truncated).toBe(false);
    expect(
      toCandidateDetail(candidateInputs({ resumes: { ...candidateInputs().resumes, total: 60 } }))
        .resume.truncated,
    ).toBe(true);
  });

  it("account: consent incl. employer_sharing, devices, flag, profile road and form level", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.account.consent).toEqual({
      state: "active",
      consent_version: "2026-11-04",
      accepted_at: "2026-11-01T10:00:00.000Z",
      purposes: ["profiling", "resume_generation", "employer_sharing"],
      employer_sharing: true,
    });
    expect(d.account.devices).toEqual({
      count: 1,
      latest_app_version: "1.4.2",
      last_seen_at: "2026-11-01T10:00:00.000Z",
    });
    expect(d.account.flag).toEqual({ flagged: false, reason_code: null, flagged_at: null });
    expect(d.account.profile).toEqual({
      status: "confirmed",
      source: "interview",
      confirmed_at: "2026-11-01T10:00:00.000Z",
      form_level: "medium",
    });
    expect(d.account.is_sample).toBe(false);
    expect(d.worker_id).toBe(FIXTURE_WORKER_ID);
  });

  it("a revoked latest consent is `revoked` and shares nothing", () => {
    const base = candidateInputs();
    const d = toCandidateDetail({
      ...base,
      account: {
        ...base.account,
        consent: { ...base.account.consent!, revokedAt: new Date("2026-11-02T00:00:00Z") },
      },
    });
    expect(d.account.consent.state).toBe("revoked");
    expect(d.account.consent.employer_sharing).toBe(false);
  });

  it("activity counts applied and skipped separately", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.activity).toMatchObject({ application_count: 3, skipped_count: 5, unlock_count: 2 });
  });
});

describe("editable — the raw correction-shaped values for the admin forms", () => {
  it("prefills skills verbatim, work-type and document codes, and the stored rows", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.editable.skills).toEqual(["MIG Welding", "Arc Welding"]);
    expect(d.editable.work_types).toEqual(["contract"]);
    expect(d.editable.documents_ready).toEqual(["aadhaar", "pan"]);
    expect(d.editable.languages).toBeNull();
    expect(d.editable.education).toEqual([]);
    expect(d.editable.certifications).toEqual([]);
    expect(d.editable.training).toEqual([]);
  });

  it("languages map the stored rows to the correction shape, or null with no rows", () => {
    const d = toCandidateDetail(
      candidateInputs({
        languages: [
          { language: "hindi", canSpeak: true, canRead: true, canWrite: false },
          { language: "english", canSpeak: true, canRead: false, canWrite: false },
        ],
      }),
    );
    expect(d.editable.languages).toEqual([
      { language: "hindi", can_speak: true, can_read: true, can_write: false },
      { language: "english", can_speak: true, can_read: false, can_write: false },
    ]);
  });

  it("education, certificate and training rows map verbatim, without licence data for a non-editor", () => {
    const d = toCandidateDetail(
      candidateInputs({
        qualifications: {
          certificates: [
            {
              name: "Welding safety",
              issuer: "ITI",
              year: 2020,
              licenceNumberEnc: "enc",
              licenceExpiry: "2030-01-01",
            },
          ],
          educations: [
            {
              credential: "iti",
              field: "Machinist",
              council: "ncvt",
              year: 2018,
              institute: "Govt. ITI",
            },
          ],
          trainings: [{ name: "MIG course", provider: null, year: 2019 }],
        },
      }),
    );
    expect(d.editable.education).toEqual([
      {
        credential: "iti",
        field: "Machinist",
        council: "ncvt",
        year: 2018,
        institute: "Govt. ITI",
      },
    ]);
    expect(d.editable.certifications).toEqual([
      {
        name: "Welding safety",
        issuer: "ITI",
        year: 2020,
        licence_number: null,
        licence_expiry: null,
      },
    ]);
    expect(d.editable.training).toEqual([{ name: "MIG course", provider: null, year: 2019 }]);
  });

  it("prefills the decrypted certificate licence fields for an editor (#2728)", () => {
    const d = toCandidateDetail(
      candidateInputs({
        editableCertificates: [
          {
            name: "Welding safety",
            issuer: "ITI",
            year: 2020,
            licence_number: "WB-1234",
            licence_expiry: "2030-01-01",
          },
        ],
      }),
    );
    expect(d.editable.certifications).toEqual([
      {
        name: "Welding safety",
        issuer: "ITI",
        year: 2020,
        licence_number: "WB-1234",
        licence_expiry: "2030-01-01",
      },
    ]);
  });

  it("work history maps without employer names, polish state or voice notes", () => {
    const d = toCandidateDetail(candidateInputs());
    expect(d.editable.work_history).toEqual([
      {
        employer_city: "Pune",
        employer_state: "Maharashtra",
        start_ym: "2021-04",
        end_ym: null,
        roles: [
          {
            role_label: "Welder",
            start_ym: "2021-04",
            end_ym: null,
            work_done: "MIG welding of frames",
          },
        ],
      },
    ]);
    expect(JSON.stringify(d.editable.work_history)).not.toMatch(
      /employer_name|voice_note|polish|duration_stated/,
    );
  });

  it("a live skills correction wins over the stored profile", () => {
    const d = toCandidateDetail(
      candidateInputs({
        corrections: [
          {
            id: "c1c1c1c1-0000-4000-8000-000000000001",
            factKey: "skills",
            adminId: FIXTURE_ADMIN_ID,
            reasonCode: "worker_request",
            createdAt: new Date("2026-11-06T10:00:00Z"),
            corrected: ["skill_tig_welding"],
          },
        ],
      }),
    );
    expect(d.editable.skills).toEqual(["skill_tig_welding"]);
  });
});
