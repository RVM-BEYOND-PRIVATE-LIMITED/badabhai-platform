/**
 * THE PROVENANCE DIGEST HAS TO SURVIVE A ROUND TRIP THROUGH POSTGRES — and it very nearly did not.
 *
 * `provenanceDigest` is a sha256 over 19 candidate fields in a declared order
 * (packages/db/src/skill-discovery-candidate.ts:252-272). Eighteen of them are ids, enums, arrays
 * and numbers, and they round-trip exactly. The nineteenth is `created_at`, and it is hashed AS
 * THE STRING THE WRITER STORED — which means the read path has to reproduce that string byte for
 * byte, and "reproduce a timestamp byte for byte" is a question with a wrong answer that looks
 * completely reasonable.
 *
 * ── THE DEFECT THIS FILE EXISTS FOR ──────────────────────────────────────────────────────
 * The admin repository originally rendered `created_at` for the digest with the SAME SQL fragment
 * it uses for the keyset cursor: `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, six fractional
 * digits, because microseconds are exactly what a cursor must not lose. But the writer
 * (`db:persist:discovery-run`, inserting `startedAt.toISOString()` — discover-skills.ts:246)
 * hashed a THREE-digit string. So the digest was taken over `...:59.123Z` and recomputed over
 * `...:59.123000Z`, and `validateCandidate` returned PROVENANCE_DIGEST_MISMATCH for every
 * candidate in the table.
 *
 * AND IT WOULD NOT HAVE BLOCKED ANYTHING, which is the part worth a file of its own. The decision
 * path refuses only problems a write INTRODUCES — deliberately, so a row the pipeline already
 * shipped with a flaw is still decidable by a human — so a mismatch present BEFORE the decision is
 * filtered out as pre-existing. Every decision would have succeeded. The only visible effect would
 * have been `provenance_digest`, served on the review screen precisely so a reader can tell that a
 * row's lineage still checks out, quietly reporting "broken" on every row forever. An integrity
 * alarm that fires on everything has been switched off, and this one would have arrived that way.
 *
 * ── SO THE ASSERTIONS BELOW RUN IN BOTH DIRECTIONS ───────────────────────────────────────
 * A test that only asserted "the millisecond form reconciles" would still pass if somebody made
 * `provenanceDigest` ignore `created_at` altogether, or made `validateCandidate` stop checking the
 * digest. So each positive assertion is paired with a negative one proving the check is CAPABLE of
 * firing: the microsecond form must fail, and it must fail with exactly PROVENANCE_DIGEST_MISMATCH.
 *
 * NO DATABASE. What is under test is the agreement between two string formats and one hash, and
 * that agreement is decidable without a connection. The half a connection WOULD add — that
 * Postgres's millisecond `to_char` emits what `renderMs` emits — is pinned instead by asserting
 * the repository's own SQL fragments, so a swap back to the cursor format is a failing test rather
 * than a silent regression.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  candidateId,
  provenanceDigest,
  validateCandidate,
  type SkillCandidateRecord,
} from "@badabhai/db";

/**
 * How the WRITER stamps `created_at`: `Date.prototype.toISOString`, specified to emit exactly
 * three fractional digits and a literal `Z`. Asserted below rather than assumed, because the whole
 * agreement rests on it.
 */
function writerStamp(d: Date): string {
  return d.toISOString();
}

/**
 * How the READ path must render it — the millisecond `to_char` form, three fractional digits.
 * Modelled in JS so the agreement is testable without a database; the real SQL fragment is pinned
 * by the source assertions at the end of this file.
 */
function renderMs(d: Date): string {
  return d.toISOString();
}

/** The OLD, wrong rendering: six fractional digits. Kept so the failure can be reproduced. */
function renderUs(d: Date): string {
  return `${d.toISOString().slice(0, -1)}000Z`;
}

const CREATED = new Date("2026-08-26T12:35:59.123Z");

/**
 * A candidate as the pipeline sealed it, with `created_at` stamped the way the writer stamps it.
 *
 * Every provenance field carries a real-shaped value: a digest over defaults would still be a
 * digest, but it would not exercise the field ordering the function depends on.
 */
function sealedCandidate(createdAt: string): SkillCandidateRecord {
  const runId = "sdr_20260826-123559Z_phase5";
  const clusterKey = "shuttering erection";
  const base = {
    // The DETERMINISTIC id, minted the way the pipeline mints it. A hand-written uuid here would
    // make every record in this file carry a standing CANDIDATE_ID_MISMATCH, and the
    // "no problem at all" assertion would have had to be weakened to accommodate it — which is
    // how a test stops being able to see the thing it was written for.
    candidate_id: candidateId(runId, clusterKey),
    run_id: runId,
    cluster_key: clusterKey,
    normalized_phrase: "shuttering erection",
    phrase_class: "ACTIVITY_PHRASE",
    classifier_rule: "ACTIVITY_HEADED",
    occupation_heads: [],
    evidence_tokens: ["shuttering"],
    trade_family: "Building Frame and Related Trades Workers",
    source_alias_count: 2,
    source_domain_count: 1,
    proposed_action: "create",
    confidence_band: "low",
    confidence: null,
    embedding_status: "embedded",
    model: null,
    prompt_version: null,
    corpus_fingerprint: "12323db49e7996291c0189a441cc01e7",
    created_at: createdAt,
    status: "needs_review",
    proposed_skill_name: "Shuttering Erection",
    proposed_description: null,
    approved_job_domain_ids: [],
    approved_requirement: "preferred",
    reviewer_admin_id: null,
    reviewed_at: null,
    review_reason: null,
    resulting_skill_id: null,
    sources: [
      {
        source_type: "job_domain_alias",
        source_id: "jda_1",
        original_text: "shuttering",
        normalized_text: "shuttering",
        job_domain_id: "jd_carpenter",
      },
      {
        source_type: "job_domain_alias",
        source_id: "jda_2",
        original_text: "shuttering erection",
        normalized_text: "shuttering erection",
        job_domain_id: "jd_carpenter",
      },
    ],
    matches: [],
  } as unknown as SkillCandidateRecord;
  return { ...base, provenance_digest: provenanceDigest(base) };
}

/** Re-assemble the same candidate the way a READ path does: from the row's rendered string. */
function asRead(sealed: SkillCandidateRecord, renderedCreatedAt: string): SkillCandidateRecord {
  return { ...sealed, created_at: renderedCreatedAt };
}

describe("the writer's stamp is the format this whole agreement rests on", () => {
  it("toISOString emits exactly three fractional digits and a Z", () => {
    // If this ever stops being true, every assertion below is measuring the wrong thing — so it
    // is checked rather than assumed. Six digits vs three is only a defect BECAUSE of this line.
    expect(writerStamp(CREATED)).toBe("2026-08-26T12:35:59.123Z");
    expect(writerStamp(new Date("2026-08-26T12:35:59.000Z"))).toBe("2026-08-26T12:35:59.000Z");
  });

  it("the two renderings are NOT the same string — the premise of the defect", () => {
    expect(renderMs(CREATED)).toBe("2026-08-26T12:35:59.123Z");
    expect(renderUs(CREATED)).toBe("2026-08-26T12:35:59.123000Z");
    expect(renderMs(CREATED)).not.toBe(renderUs(CREATED));
  });
});

describe("the digest reconciles across the round trip — and only at the writer's precision", () => {
  const sealed = sealedCandidate(writerStamp(CREATED));

  it("the millisecond rendering reproduces the stored digest exactly", () => {
    expect(provenanceDigest(asRead(sealed, renderMs(CREATED)))).toBe(sealed.provenance_digest);
  });

  it("and validateCandidate finds no problem at all with it", () => {
    // The whole record, not just the digest: a record that reconciles but trips something else
    // would still be a broken row, so the assertion is the empty list.
    expect(validateCandidate(asRead(sealed, renderMs(CREATED)))).toEqual([]);
  });

  it("the SIX-digit rendering breaks the digest — the check is capable of firing", () => {
    expect(provenanceDigest(asRead(sealed, renderUs(CREATED)))).not.toBe(sealed.provenance_digest);
  });

  it("and it fails as exactly PROVENANCE_DIGEST_MISMATCH, not as some other complaint", () => {
    const problems = validateCandidate(asRead(sealed, renderUs(CREATED)));
    expect(problems.map((p) => p.code)).toEqual(["PROVENANCE_DIGEST_MISMATCH"]);
  });

  it("three trailing zeros are enough on their own — no unusual timestamp is needed", () => {
    // The defect was not about exotic values. A round-second `created_at` — the most ordinary
    // thing a run produces — already renders differently under the two formats.
    const round = new Date("2026-08-26T12:00:00.000Z");
    const s = sealedCandidate(writerStamp(round));
    expect(provenanceDigest(asRead(s, renderMs(round)))).toBe(s.provenance_digest);
    expect(provenanceDigest(asRead(s, renderUs(round)))).not.toBe(s.provenance_digest);
  });
});

describe("the repository's own SQL keeps the two questions apart", () => {
  const source = readFileSync(join(__dirname, "admin-skill-discovery.repository.ts"), "utf8");

  it("the DIGEST rendering uses the millisecond form — the writer's precision", () => {
    // A source assertion, because the alternative is a live connection and the thing being
    // protected is one character. `PROVENANCE_CREATED_AT` is what `findCandidate` projects into
    // `created_at_iso`, and `created_at_iso` is what the decision path hashes.
    expect(source).toMatch(/PROVENANCE_CREATED_AT = sql<string>`to_char\([\s\S]*?\.MS"Z"'\)`/);
  });

  it("the CURSOR key still uses the microsecond form — a keyset must not lose a digit", () => {
    // The two must not be unified. Many rows per millisecond is not hypothetical on this table:
    // a whole run's candidates share one `created_at`, so the cursor's timestamp and its
    // tie-breaker are both doing real work.
    expect(source).toMatch(/SORT_KEY = sql<string>`to_char\([\s\S]*?\.US"Z"'\)`/);
  });

  it("created_at_iso is projected from the DIGEST fragment, not from the cursor one", () => {
    // The defect was exactly this line naming the wrong constant, which is why it is pinned as a
    // line rather than inferred from the two assertions above.
    expect(source).toContain("createdAtIso: AdminSkillDiscoveryRepository.PROVENANCE_CREATED_AT");
    expect(source).not.toContain("createdAtIso: AdminSkillDiscoveryRepository.SORT_KEY");
  });
});
