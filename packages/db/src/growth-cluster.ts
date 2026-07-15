/**
 * Growth-loop runner (ADR-0030 / TAX-7 "fork B" pattern — owner connection).
 *
 * Turns the below-floor `unresolved_phrase` queue into HUMAN-GATED vocabulary proposals:
 *
 *   1. EMBED: open rows with `embedding IS NULL` are embedded via the ai-service
 *      `POST /embeddings/skill-alias` (SG-2 pseudonymize-first fail-closed happens
 *      in-service; phrase text at rest is ALREADY pseudonymized — SG-1) and the vectors
 *      are written back to `unresolved_phrase.embedding` (DB write stays HERE — the
 *      ai-service is DB-free). Rows that fail to embed (blocked / provider errors /
 *      budget stop) stay NULL; the run CONTINUES on what did embed and the packet is
 *      stamped PARTIAL (see below).
 *   2. CLUSTER: per domain, open embedded rows + the embedded `skill_alias` anchors are
 *      POSTed to `POST /growth/cluster` (pure compute — greedy cosine clustering; guards:
 *      cluster size OR summed frequency). Proposals: alias-on-NEAR-skill (centroid in the
 *      [band_low, floor) band) or provisional-skill (no near anchor, NO id minted — SG-5).
 *   3. REPORT: proposals are rendered into docs/registers/skill-growth-proposals.md as
 *      paste-ready `wedge-aliases.ts` entries (`ratified: false`). An existing packet is
 *      first backed up to skill-growth-proposals.prev.md (one slot) — and because the
 *      packet is DERIVED data (the DB rows are the source), any lost packet can always be
 *      regenerated via `--reopen-clustered` + a re-run. Phrase text is SANITIZED at
 *      render (control chars stripped, backticks replaced, length-clamped): the queue
 *      stores payer/worker free text, i.e. HOSTILE input — it must not be able to forge
 *      markdown structure (e.g. close the ```ts fence and inject a fake "paste-ready"
 *      block) in the packet a human ratifies from.
 *   4. `--apply` (optional): member rows of EMITTED proposals move `open` → `clustered`
 *      (the TAX-1 status machine) so the next run only re-clusters what's still open.
 *      Default is REPORT-ONLY. `--apply` is REFUSED on a PARTIAL embed run (clusters
 *      formed without their unembedded relatives must stay reproposable). Run `--apply`
 *      only AFTER the packet is committed/triaged; for rejected proposals (or to
 *      regenerate anything), `--reopen-clustered` moves ALL clustered rows back to open —
 *      clustering is deterministic, so the same proposals re-emerge plus any new ones.
 *
 * THE ONLY ACTIVATION PATH is the existing ratification flow: human pastes → RVM flips
 * `ratified` → `db:seed:skills` inserts → `db:embed:skills` backfills. This runner
 * activates NOTHING (SG-3: any proposed skill_id came from the closed anchor set —
 * re-verified on the response).
 *
 * GUARDED: refuses NODE_ENV === "production" (ops action; prod run is a deliberate,
 *   gated step) and refuses to PERSIST mock phrase vectors unless `--allow-mock`:
 *   mock vectors written next to a REAL-embedded alias corpus would poison every
 *   centroid-vs-anchor comparison (there is no provenance column — the SR-1 lesson).
 *   `--reset-embeddings` is the mixed-space recovery (NULL ALL phrase vectors).
 *
 *   pnpm db:growth:cluster                     # report-only (writes packet + vectors)
 *   pnpm db:growth:cluster --apply             # also mark proposal members 'clustered'
 *   pnpm db:growth:cluster --allow-mock        # dev only: permit persisting MOCK vectors
 *   pnpm db:growth:cluster --reset-embeddings  # NULL all phrase vectors (mixed-space recovery)
 *   pnpm db:growth:cluster --reopen-clustered  # clustered → open (rejected/lost proposals)
 *   (DATABASE_URL from env/.env; AI_SERVICE_URL defaults to http://localhost:8000;
 *    GROWTH_REPORT_PATH overrides the packet location.)
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";
import { and, eq, inArray, isNull, isNotNull, notInArray } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseEmbedResponse } from "./embed-response";
import { skillAliases, unresolvedPhrases } from "./schema";

config({ path: "../../.env" });

const EMBED_BATCH_SIZE = Math.max(1, Math.min(200, Number(process.env.EMBED_BATCH_SIZE) || 100));
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Request caps — MUST match the Pydantic/Zod GrowthClusterInput caps. */
const MAX_PHRASES_PER_DOMAIN = 500;
const MAX_ANCHORS = 5000;
/** Render caps for packet display strings (parse rejects anything longer). */
const MAX_DISPLAY_LEN = 500;

/** Sanitize QUEUE-DERIVED text before it enters the markdown packet. The phrase column
 * is pseudonymized (SG-1) but otherwise HOSTILE free text: strip control chars/newlines
 * (no forged headings/blockquotes/fences), replace backticks (cannot close the ```ts
 * paste-ready fence or open inline code), clamp length. Applied at RENDER — the DB keeps
 * the original text. */
function safeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/`/g, "'");
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

interface GrowthProposal {
  kind: "alias" | "provisional_skill";
  skill_id: string | null;
  leader_phrase: string;
  member_ids: string[];
  member_phrases: string[];
  total_count: number;
  nearest_skill_id: string | null;
  nearest_score: number | null;
  note: string | null;
}
interface GrowthResponse {
  proposals: GrowthProposal[];
  phrases_in: number;
  clusters_total: number;
  clusters_eligible: number;
  skipped_below_guards: number;
}

/** Validate the /growth/cluster response SHAPE + the SG-3/SG-5 properties at runtime:
 * every member_id must be a phrase id we sent; an alias skill_id must be an anchor
 * skill_id we sent; a provisional proposal must carry NO skill_id; display strings are
 * length-capped (they feed the packet renderer). A violation aborts — a proposal packet
 * must never contain an id the closed set didn't supply. */
function parseGrowthResponse(
  raw: unknown,
  sentPhraseIds: Set<string>,
  sentAnchorSkillIds: Set<string>,
): GrowthResponse {
  const bad = (why: string): never => {
    throw new Error(`[growth] malformed ai-service response — ${why}`);
  };
  const displayString = (v: unknown, field: string): string => {
    if (typeof v !== "string" || v.length > MAX_DISPLAY_LEN) {
      bad(`${field} is not a string <= ${MAX_DISPLAY_LEN} chars`);
    }
    return v as string;
  };
  if (typeof raw !== "object" || raw === null) bad("not an object");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.proposals)) bad("proposals is not an array");
  const proposals: GrowthProposal[] = [];
  for (const p of o.proposals as unknown[]) {
    if (typeof p !== "object" || p === null) bad("proposal is not an object");
    const it = p as Record<string, unknown>;
    if (it.kind !== "alias" && it.kind !== "provisional_skill") {
      bad(`unknown proposal kind ${String(it.kind)}`);
    }
    const skillId = it.skill_id ?? null;
    if (it.kind === "alias") {
      if (typeof skillId !== "string" || !sentAnchorSkillIds.has(skillId)) {
        bad(`alias proposal skill_id ${String(skillId)} is not one of the sent anchors (SG-3)`);
      }
    } else if (skillId !== null) {
      bad(`provisional proposal carries a skill_id ${String(skillId)} (SG-5 violation)`);
    }
    if (!Array.isArray(it.member_ids) || it.member_ids.length === 0) bad("member_ids empty");
    for (const id of it.member_ids as unknown[]) {
      if (typeof id !== "string" || !sentPhraseIds.has(id)) {
        bad(`member id ${String(id)} was not in the request`);
      }
    }
    if (
      !Array.isArray(it.member_phrases) ||
      it.member_phrases.length !== (it.member_ids as unknown[]).length
    ) {
      bad("member_phrases does not pair 1:1 with member_ids");
    }
    const memberPhrases = (it.member_phrases as unknown[]).map((s, i) =>
      displayString(s, `member_phrases[${i}]`),
    );
    if (typeof it.total_count !== "number") bad("total_count malformed");
    proposals.push({
      kind: it.kind as "alias" | "provisional_skill",
      skill_id: skillId as string | null,
      leader_phrase: displayString(it.leader_phrase, "leader_phrase"),
      member_ids: it.member_ids as string[],
      member_phrases: memberPhrases,
      total_count: it.total_count as number,
      nearest_skill_id: typeof it.nearest_skill_id === "string" ? it.nearest_skill_id : null,
      nearest_score: typeof it.nearest_score === "number" ? it.nearest_score : null,
      note: it.note == null ? null : displayString(it.note, "note"),
    });
  }
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    proposals,
    phrases_in: num(o.phrases_in),
    clusters_total: num(o.clusters_total),
    clusters_eligible: num(o.clusters_eligible),
    skipped_below_guards: num(o.skipped_below_guards),
  };
}

interface PhraseRow {
  id: string;
  phrase: string;
  lang: string | null;
  count: number;
  embedding: number[] | null;
}

/** Phase 1: embed open rows whose vector is NULL. Refuses to persist MOCK vectors unless
 * allowed (mixed vector space poisons clustering). NEVER throws on a no-progress batch:
 * rows that fail to embed stay NULL and the RUN CONTINUES on the embedded subset — the
 * caller detects the leftovers and stamps the packet PARTIAL (+ refuses --apply). The
 * loop still cannot spin: every iteration either progresses, grows `blocked`, or breaks. */
async function embedOpenPhrases(
  db: ReturnType<typeof createDbClient>["db"],
  aiBase: string,
  allowMock: boolean,
): Promise<{ embedded: number; blocked: string[]; embedIncomplete: boolean }> {
  const blocked: string[] = [];
  let embedded = 0;
  let embedIncomplete = false;
  for (;;) {
    const rows = await db
      .select({ id: unresolvedPhrases.id, phrase: unresolvedPhrases.phrase })
      .from(unresolvedPhrases)
      .where(
        blocked.length > 0
          ? and(
              eq(unresolvedPhrases.status, "open"),
              isNull(unresolvedPhrases.embedding),
              notInArray(unresolvedPhrases.id, blocked),
            )
          : and(eq(unresolvedPhrases.status, "open"), isNull(unresolvedPhrases.embedding)),
      )
      .orderBy(unresolvedPhrases.id)
      .limit(EMBED_BATCH_SIZE);
    if (rows.length === 0) break;

    const resp = await fetch(`${aiBase}/embeddings/skill-alias`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: rows.map((r) => ({ alias_id: r.id, text: r.phrase })) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`[growth] ai-service HTTP ${resp.status} on embed — aborting`);
    }
    const data = parseEmbedResponse(await resp.json(), new Set(rows.map((r) => r.id)));
    if (data.is_mock && !allowMock) {
      throw new Error(
        "[growth] the ai-service returned MOCK vectors — refusing to persist them next to " +
          "a (possibly real-embedded) alias corpus; there is no provenance column, so a " +
          "mixed space silently poisons clustering. Enable real embeds (SG-4 gates) or " +
          "pass --allow-mock in a fully-mock dev DB (--reset-embeddings recovers a mix).",
      );
    }

    let savedThisBatch = 0;
    let blockedThisBatch = 0;
    for (const r of data.results) {
      if (r.blocked || r.vector === null) {
        blocked.push(r.alias_id);
        blockedThisBatch += 1;
        continue;
      }
      await db
        .update(unresolvedPhrases)
        .set({ embedding: r.vector })
        .where(eq(unresolvedPhrases.id, r.alias_id));
      embedded += 1;
      savedThisBatch += 1;
    }

    if (data.budget_stopped) {
      console.log(
        "[growth] BUDGET STOP on embed — remaining rows stay NULL; continuing PARTIAL " +
          "(re-run later to embed the rest).",
      );
      embedIncomplete = true;
      break;
    }
    if (savedThisBatch === 0 && blockedThisBatch === 0) {
      // Every item errored on the provider: refetching would return the same rows.
      // Do NOT throw — the already-embedded rows are still clusterable; continue PARTIAL.
      console.log(
        `[growth] embed batch made no progress (provider errors=${data.errors}) — ` +
          "leaving remaining rows NULL and continuing PARTIAL.",
      );
      embedIncomplete = true;
      break;
    }
    if (rows.length < EMBED_BATCH_SIZE) break;
  }
  return { embedded, blocked, embedIncomplete };
}

function renderPacket(
  generatedAt: string,
  partial: boolean,
  sections: {
    domainId: string;
    phrases: PhraseRow[];
    anchorCount: number;
    result: GrowthResponse;
  }[],
): string {
  const lines: string[] = [
    "# Skill growth proposals (ADR-0030 / TAX-7) — GENERATED, human-gated",
    "",
    `> Generated by \`pnpm db:growth:cluster\` at ${generatedAt}. REPORT-ONLY — nothing in`,
    "> this file is active. All phrase text below is SG-1 PSEUDONYMIZED (that is what the",
    "> queue stores) and SANITIZED for display; no worker identity exists in this pipeline",
    "> (aggregate counts only).",
    ">",
    "> **The only activation path:** copy an alias entry into",
    "> `packages/taxonomy/src/wedge-aliases.ts` (it ships `ratified: false`), the RVM domain",
    "> owner flips `ratified` after review, `pnpm db:seed:skills` inserts it, and",
    "> `pnpm db:embed:skills` backfills its vector. Provisional clusters need a human",
    "> taxonomy decision in `packages/taxonomy` — NO skill id was minted for them (SG-5).",
    "",
  ];
  if (partial) {
    lines.push(
      "> ⚠️ **PARTIAL RUN** — some open phrases could not be embedded (blocked / provider",
      "> errors / budget stop) and are missing from these clusters. `--apply` was refused;",
      "> re-run after the embed gap clears before treating this packet as complete.",
      "",
    );
  }
  for (const s of sections) {
    const byId = new Map(s.phrases.map((p) => [p.id, p]));
    const aliasProps = s.result.proposals.filter((p) => p.kind === "alias");
    const provProps = s.result.proposals.filter((p) => p.kind === "provisional_skill");
    lines.push(
      `## Domain \`${s.domainId}\``,
      "",
      `${s.result.phrases_in} open phrases · ${s.anchorCount} anchors · ` +
        `${s.result.clusters_total} clusters (${s.result.clusters_eligible} eligible, ` +
        `${s.result.skipped_below_guards} below guards)`,
      "",
    );
    const memberLine = (p: GrowthProposal): string =>
      p.member_ids
        .map((id, i) => {
          const row = byId.get(id);
          const text = safeText(p.member_phrases[i] ?? row?.phrase ?? "?");
          return `"${text}" (${row?.lang ?? "?"}, ×${row?.count ?? "?"})`;
        })
        .join(" · ");
    if (aliasProps.length > 0) {
      lines.push("### Alias proposals (near an EXISTING skill)", "");
      aliasProps.forEach((p, i) => {
        const leader = safeText(p.leader_phrase);
        const lang = safeText(byId.get(p.member_ids[0] ?? "")?.lang ?? "hi");
        lines.push(
          `#### A${i + 1}. "${leader}" → \`${p.skill_id}\` (score ${p.nearest_score ?? "?"}, total ×${p.total_count})`,
          "",
          `Members: ${memberLine(p)}`,
          ...(p.note ? ["", `> ${safeText(p.note)}`] : []),
          "",
          "```ts",
          `{ skillId: ${JSON.stringify(p.skill_id)}, alias: { text: ${JSON.stringify(leader)}, lang: ${JSON.stringify(lang)}, source: "rvm" }, ratified: false },`,
          "```",
          "",
        );
      });
    }
    if (provProps.length > 0) {
      lines.push(
        "### Provisional-skill clusters (no near skill — human taxonomy decision)",
        "",
      );
      provProps.forEach((p, i) => {
        const nearest =
          p.nearest_skill_id === null
            ? "none"
            : `\`${safeText(p.nearest_skill_id)}\` @ ${p.nearest_score ?? "?"}`;
        lines.push(
          `#### P${i + 1}. "${safeText(p.leader_phrase)}" (total ×${p.total_count}, nearest existing: ${nearest})`,
          "",
          `Members: ${memberLine(p)}`,
          ...(p.note ? ["", `> ${safeText(p.note)}`] : []),
          "",
        );
      });
    }
    if (s.result.proposals.length === 0) {
      lines.push("_No eligible clusters — nothing to propose._", "");
    }
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[growth] refusing to run in production (run is §7-gated ops).");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[growth] DATABASE_URL is not set");
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const apply = process.argv.includes("--apply");
  const allowMock = process.argv.includes("--allow-mock");
  // Anchored to THIS FILE, not cwd — `tsx src/growth-cluster.ts` from the repo root must
  // not resolve outside the repo. __dirname = packages/db/src (CJS via tsx).
  const reportPath =
    process.env.GROWTH_REPORT_PATH ??
    path.resolve(__dirname, "../../../docs/registers/skill-growth-proposals.md");

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // --reset-embeddings: NULL ALL phrase vectors and exit — the mixed-vector-space
    // recovery (mirrors embed-skill-aliases.ts; no provenance column exists).
    if (process.argv.includes("--reset-embeddings")) {
      const reset = await db
        .update(unresolvedPhrases)
        .set({ embedding: null })
        .where(isNotNull(unresolvedPhrases.embedding))
        .returning({ id: unresolvedPhrases.id });
      console.log(`[growth] reset — ${reset.length} phrase embeddings set to NULL; re-run to re-embed.`);
      return;
    }

    // --reopen-clustered: clustered → open and exit. The recovery for REJECTED proposals
    // and for any lost/overwritten packet: clustering is deterministic, so reopening +
    // re-running regenerates the same proposals (plus new arrivals). Without this the
    // status machine would be a one-way door (nothing else writes 'clustered' back).
    if (process.argv.includes("--reopen-clustered")) {
      const reopened = await db
        .update(unresolvedPhrases)
        .set({ status: "open" })
        .where(eq(unresolvedPhrases.status, "clustered"))
        .returning({ id: unresolvedPhrases.id });
      console.log(`[growth] reopened ${reopened.length} clustered row(s) → open; re-run to re-propose.`);
      return;
    }

    // Phase 1 — embed NULL-vector open rows (continues PARTIAL on embed gaps).
    const { embedded, blocked, embedIncomplete } = await embedOpenPhrases(db, aiBase, allowMock);
    console.log(`[growth] embed phase — embedded=${embedded} blocked=${blocked.length}`);
    if (blocked.length > 0) {
      console.log("[growth] blocked phrase ids (left NULL, pseudonymize fail-closed):");
      for (const id of blocked) console.log(`  - ${id}`);
    }
    // PARTIAL when an embed gap remains: provider/budget leftovers (embedIncomplete) or
    // fail-closed blocked rows from THIS run. Blocked rows never embed until their text
    // is fixed, so they keep the packet honest rather than silently absent.
    const partial = embedIncomplete || blocked.length > 0;

    // Phase 2 — cluster per domain.
    const open = await db
      .select({
        id: unresolvedPhrases.id,
        phrase: unresolvedPhrases.phrase,
        lang: unresolvedPhrases.lang,
        count: unresolvedPhrases.count,
        embedding: unresolvedPhrases.embedding,
        domainId: unresolvedPhrases.domainId,
      })
      .from(unresolvedPhrases)
      .where(and(eq(unresolvedPhrases.status, "open"), isNotNull(unresolvedPhrases.embedding)))
      .orderBy(unresolvedPhrases.id);

    const noDomain = open.filter((r) => r.domainId === null);
    if (noDomain.length > 0) {
      console.log(
        `[growth] WARNING: skipping ${noDomain.length} open row(s) with NULL domain_id — ` +
          "clustering is domain-scoped; backfill domain_id or resolve them by hand.",
      );
    }
    const domains = [...new Set(open.map((r) => r.domainId).filter((d): d is string => d !== null))].sort();

    const sections: Parameters<typeof renderPacket>[2] = [];
    const emittedMemberIds: string[] = [];
    for (const domainId of domains) {
      let phrases = open
        .filter((r): r is typeof r & { domainId: string } => r.domainId === domainId)
        .map((r): PhraseRow => ({ id: r.id, phrase: r.phrase, lang: r.lang, count: r.count, embedding: r.embedding }));
      if (phrases.length > MAX_PHRASES_PER_DOMAIN) {
        console.log(
          `[growth] WARNING: domain ${domainId} has ${phrases.length} open phrases — ` +
            `clustering the top ${MAX_PHRASES_PER_DOMAIN} by count this run (commit+triage this packet, --apply, then re-run for the rest).`,
        );
        phrases = [...phrases]
          .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
          .slice(0, MAX_PHRASES_PER_DOMAIN);
      }

      const anchors = await db
        .select({ skillId: skillAliases.skillId, embedding: skillAliases.embedding })
        .from(skillAliases)
        .where(and(eq(skillAliases.domainId, domainId), isNotNull(skillAliases.embedding)))
        .orderBy(skillAliases.id)
        .limit(MAX_ANCHORS);
      if (anchors.length === MAX_ANCHORS) {
        console.log(
          `[growth] WARNING: domain ${domainId} hit the ${MAX_ANCHORS}-anchor request cap — ` +
            "anchors beyond it are not compared this run (raise the contract caps if the corpus outgrew them).",
        );
      }

      const resp = await fetch(`${aiBase}/growth/cluster`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domain_id: domainId,
          phrases: phrases.map((p) => ({ id: p.id, phrase: p.phrase, count: p.count, vector: p.embedding })),
          anchors: anchors.map((a) => ({ skill_id: a.skillId, vector: a.embedding })),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error(`[growth] ai-service HTTP ${resp.status} on cluster (${domainId}) — aborting`);
      }
      const result = parseGrowthResponse(
        await resp.json(),
        new Set(phrases.map((p) => p.id)),
        new Set(anchors.map((a) => a.skillId)),
      );
      console.log(
        `[growth] ${domainId}: phrases=${result.phrases_in} clusters=${result.clusters_total} ` +
          `eligible=${result.clusters_eligible} proposals=${result.proposals.length}`,
      );
      sections.push({ domainId, phrases, anchorCount: anchors.length, result });
      for (const p of result.proposals) emittedMemberIds.push(...p.member_ids);
    }

    // Phase 3 — write the packet (even when empty: the empty packet is the evidence).
    // Back the previous packet up first (one slot): the packet is derived data — full
    // recovery for anything older is --reopen-clustered + re-run — but the single backup
    // keeps an un-triaged previous run visible after an accidental re-run.
    if (existsSync(reportPath)) {
      const backupPath = reportPath.replace(/\.md$/, ".prev.md");
      copyFileSync(reportPath, backupPath);
      console.log(`[growth] previous packet backed up → ${backupPath}`);
    }
    const packet = renderPacket(new Date().toISOString(), partial, sections);
    writeFileSync(reportPath, packet, "utf8");
    console.log(`[growth] packet written → ${reportPath}${partial ? " (PARTIAL)" : ""}`);

    // Phase 4 — optional status transition open → clustered for EMITTED members only.
    // Refused on a PARTIAL run: clusters formed without their unembedded relatives must
    // stay reproposable once the embed gap clears.
    if (apply && partial) {
      console.log("[growth] --apply REFUSED — PARTIAL embed run; clear the embed gap and re-run.");
    } else if (apply && emittedMemberIds.length > 0) {
      const updated = await db
        .update(unresolvedPhrases)
        .set({ status: "clustered" })
        .where(and(inArray(unresolvedPhrases.id, emittedMemberIds), eq(unresolvedPhrases.status, "open")))
        .returning({ id: unresolvedPhrases.id });
      console.log(`[growth] --apply: ${updated.length} row(s) open → clustered (undo: --reopen-clustered)`);
    } else if (apply) {
      console.log("[growth] --apply: no proposals emitted — nothing to mark");
    } else {
      console.log("[growth] report-only (pass --apply AFTER committing/triaging the packet)");
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
