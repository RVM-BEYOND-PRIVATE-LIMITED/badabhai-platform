import { describe, expect, it } from "vitest";
import {
  attributeSourceOf,
  jobDomainSourceOf,
  profileRowSource,
  workerSkillSourceOf,
  type AttributeProvenance,
} from "./profile-field-sources";

const row = (over: Partial<AttributeProvenance>): AttributeProvenance => ({
  attributeKey: "shift_preference",
  valueSource: "answer_map",
  hasPack: true,
  hasSession: true,
  answerSource: null,
  ...over,
});

describe("profileRowSource — the road through resolveResumeSource", () => {
  it("an accepted CV import wins over the road (owner ruling R1)", () => {
    expect(profileRowSource({ source: "chat", seededFromImportId: "imp-1" })).toBe("resume_import");
    expect(profileRowSource({ source: "form", seededFromImportId: "imp-1" })).toBe("resume_import");
  });

  it("chat → interview, form → form, a pre-0107 NULL road → unknown, no profile → none", () => {
    expect(profileRowSource({ source: "chat", seededFromImportId: null })).toBe("interview");
    expect(profileRowSource({ source: "form", seededFromImportId: null })).toBe("form");
    expect(profileRowSource({ source: null, seededFromImportId: null })).toBe("unknown");
    expect(profileRowSource({ source: "weird", seededFromImportId: null })).toBe("unknown");
    expect(profileRowSource(undefined)).toBe("none");
    expect(profileRowSource(null)).toBe("none");
  });
});

describe("attributeSourceOf — only what the stamped columns can tell", () => {
  it("no row → none", () => {
    expect(attributeSourceOf(undefined)).toBe("none");
  });

  it("the pack answer's own source decides first", () => {
    expect(attributeSourceOf(row({ answerSource: "chat" }))).toBe("interview");
    expect(attributeSourceOf(row({ answerSource: "chip" }))).toBe("interview");
    expect(attributeSourceOf(row({ answerSource: "form" }))).toBe("form");
    expect(attributeSourceOf(row({ answerSource: "resume", hasSession: false }))).toBe(
      "resume_import",
    );
    expect(attributeSourceOf(row({ answerSource: "ops" }))).toBe("ops");
  });

  it("no pack and no session is the worker's preferences writer; no pack WITH a session the general form", () => {
    expect(attributeSourceOf(row({ hasPack: false, hasSession: false }))).toBe("worker_edit");
    expect(attributeSourceOf(row({ hasPack: false, hasSession: true }))).toBe("form");
  });

  it("an llm_parse value with no matched answer is the interview's parse", () => {
    expect(attributeSourceOf(row({ valueSource: "llm_parse" }))).toBe("interview");
  });

  it("a pack-backed answer_map row with no matched answer is UNKNOWN — never guessed from pack/session", () => {
    expect(attributeSourceOf(row({}))).toBe("unknown");
    expect(attributeSourceOf(row({ hasSession: false }))).toBe("unknown");
  });
});

describe("workerSkillSourceOf / jobDomainSourceOf", () => {
  it("maps the worker_skill CHECK vocabulary", () => {
    expect(workerSkillSourceOf("derived_coarse")).toBe("derived");
    expect(workerSkillSourceOf("interview")).toBe("worker_edit");
    expect(workerSkillSourceOf("ops")).toBe("ops");
    expect(workerSkillSourceOf("other")).toBe("unknown");
  });

  it("a worker-confirmed occupation match is his answer; every other match is the matcher's", () => {
    expect(jobDomainSourceOf("matched_worker_confirmed")).toBe("worker_edit");
    expect(jobDomainSourceOf("matched_auto")).toBe("derived");
    expect(jobDomainSourceOf("matched_llm")).toBe("derived");
    expect(jobDomainSourceOf("unmatched_below_floor")).toBe("unknown");
    expect(jobDomainSourceOf(null)).toBe("unknown");
  });
});
