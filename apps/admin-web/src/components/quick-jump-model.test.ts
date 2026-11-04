import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdminCapability } from "../lib/auth/capabilities";
import {
  INITIAL_JUMP_STATE,
  JUMP_KINDS,
  allowedJumpKinds,
  jumpHint,
  jumpOptions,
  jumpReducer,
  moveHighlight,
  parseJumpQuery,
} from "./quick-jump-model";

const ID = "5eeded00-0001-4a00-8000-000000000001";
const ALL = JUMP_KINDS.map((k) => k.id);

/**
 * THE QUICK JUMP's model (Ctrl/⌘K, A6 #2576): what a typed line means, which records it can be
 * opened as, for which reader, and how the keyboard moves through them.
 */
describe("reading what was typed", () => {
  it("a full id — bare, padded, upper-case, or inside a pasted console address", () => {
    expect(parseJumpQuery(ID)).toEqual({ type: "id", id: ID });
    expect(parseJumpQuery(`  ${ID}\n`)).toEqual({ type: "id", id: ID });
    expect(parseJumpQuery(ID.toUpperCase())).toEqual({ type: "id", id: ID });
    expect(parseJumpQuery(`https://admin.example/candidates/${ID}/journey`)).toEqual({
      type: "id",
      id: ID,
    });
  });

  it("a short id as the console prints it is told apart — it cannot be looked up", () => {
    for (const short of ["5eeded00", "5eeded00…", "5eed…0001", "5eed...0001"]) {
      expect(parseJumpQuery(short), short).toEqual({ type: "short-id" });
    }
  });

  it("a phone number is recognised — and only recognised: there is no lookup by phone yet", () => {
    for (const phone of ["+91 98765 43210", "9876543210", "098765-43210", "(91) 9876 543 210"]) {
      expect(parseJumpQuery(phone), phone).toEqual({ type: "phone" });
    }
    // Too short to be a phone number.
    expect(parseJumpQuery("12345")).toEqual({ type: "other" });
  });

  it("nothing, and anything else", () => {
    expect(parseJumpQuery("")).toEqual({ type: "empty" });
    expect(parseJumpQuery("   ")).toEqual({ type: "empty" });
    expect(parseJumpQuery("welder pune")).toEqual({ type: "other" });
  });
});

describe("the options an id opens", () => {
  it("one per kind the reader may open, each to that record's own page", () => {
    const options = jumpOptions(parseJumpQuery(ID), ALL);
    expect(options.map((o) => [o.label, o.href])).toEqual([
      ["Candidate", `/candidates/${ID}`],
      // One customer page for a Company and an Agency alike (A6).
      ["Company or agency", `/companies/${ID}`],
      ["Posting", `/jobs/${ID}`],
      ["Agency posting", `/jobs/agency/${ID}`],
    ]);
    expect(options.every((o) => o.shortId === "5eed…0001")).toBe(true);
  });

  it("only the kinds the reader may open", () => {
    const options = jumpOptions(parseJumpQuery(ID), ["candidate", "posting"]);
    expect(options.map((o) => o.kind)).toEqual(["candidate", "posting"]);
  });

  it("nothing for anything that is not a full id — no guessing, no search", () => {
    for (const q of ["", "5eeded00", "+91 98765 43210", "welder"]) {
      expect(jumpOptions(parseJumpQuery(q), ALL), q).toEqual([]);
    }
  });
});

describe("who may jump to what — each record page's own gate", () => {
  const grants =
    (...held: AdminCapability[]) =>
    (c: AdminCapability) =>
      held.includes(c);

  it("the read floor opens candidates, customers and postings", () => {
    expect(allowedJumpKinds(grants("read_entities"))).toEqual(["candidate", "company", "posting"]);
  });

  it("agency postings need the capability every agency-job read sits on", () => {
    expect(allowedJumpKinds(grants("read_entities", "manage_agency_match_skills"))).toEqual(ALL);
    expect(allowedJumpKinds(grants())).toEqual([]);
  });

  /** Read off each page's source: the gate it calls first. */
  it.each([
    ["candidate", "(portal)/candidates/[id]/page.tsx"],
    ["posting", "(portal)/jobs/[id]/page.tsx"],
    ["agency-posting", "(portal)/jobs/agency/[jobId]/page.tsx"],
  ])("the %s kind's capability is its page's gate", (kind, page) => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "app", page),
      "utf8",
    );
    const gate = /requireCapability\(\s*"([a-z_]+)"\s*\)/.exec(src)?.[1];
    expect(JUMP_KINDS.find((k) => k.id === kind)?.capability).toBe(gate);
  });

  it("the customer kind's capability is the customer route's gate", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "payer-detail-route.tsx"),
      "utf8",
    );
    const gate = /requireCapability\(\s*"([a-z_]+)"\s*\)/.exec(src)?.[1];
    expect(JUMP_KINDS.find((k) => k.id === "company")?.capability).toBe(gate);
  });
});

describe("the hint under the field", () => {
  it("says what to type, what a pick does, and why nothing matches", () => {
    expect(jumpHint({ type: "empty" }, 0)).toMatch(/Paste a full id/);
    expect(jumpHint({ type: "id", id: ID }, 3)).toMatch(/not-found/);
    expect(jumpHint({ type: "short-id" }, 0)).toMatch(/short one cannot be looked up/);
    expect(jumpHint({ type: "phone" }, 0)).toMatch(/by phone is not available yet/);
    expect(jumpHint({ type: "other" }, 0)).toMatch(/not an id/);
  });
});

describe("the keyboard", () => {
  it("arrows wrap, Home and End go to the ends", () => {
    expect(moveHighlight(0, 3, "ArrowDown")).toBe(1);
    expect(moveHighlight(2, 3, "ArrowDown")).toBe(0);
    expect(moveHighlight(0, 3, "ArrowUp")).toBe(2);
    expect(moveHighlight(2, 3, "Home")).toBe(0);
    expect(moveHighlight(0, 3, "End")).toBe(2);
    expect(moveHighlight(1, 3, "a")).toBe(1);
    expect(moveHighlight(5, 0, "ArrowDown")).toBe(0);
  });

  it("typing starts again at the first option; pointing moves the highlight there", () => {
    let s = jumpReducer(INITIAL_JUMP_STATE, { type: "input", query: ID });
    s = jumpReducer(s, { type: "key", key: "ArrowDown", count: 3 });
    expect(s.highlight).toBe(1);
    s = jumpReducer(s, { type: "input", query: `${ID} ` });
    expect(s).toEqual({ query: `${ID} `, highlight: 0 });
    s = jumpReducer(s, { type: "point", index: 2 });
    expect(s.highlight).toBe(2);
    expect(jumpReducer(s, { type: "reset" })).toEqual(INITIAL_JUMP_STATE);
  });

  it("a key that changes nothing returns the same state (no re-render)", () => {
    const s = jumpReducer(INITIAL_JUMP_STATE, { type: "input", query: ID });
    expect(jumpReducer(s, { type: "key", key: "Shift", count: 3 })).toBe(s);
    expect(jumpReducer(s, { type: "point", index: 0 })).toBe(s);
  });
});
