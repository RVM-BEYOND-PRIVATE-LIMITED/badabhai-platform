/**
 * Offline skill re-tag runner (ADR-0030 / TAX-9 "fork B" pattern — owner connection).
 *
 * When a skill is deprecated with a successor (`skill.replaced_by`, migration 0039),
 * stored rows still carry the deprecated id. This runner re-tags them OFFLINE:
 *
 *   1. CROSSWALK: reads `skill` rows WHERE status='deprecated' AND replaced_by IS NOT
 *      NULL. Terminals that are themselves deprecated-without-successor (dead-end
 *      chains) are EXCLUDED fail-safe and reported.
 *   2. PLAN: affected rows from the two id-bearing surfaces — `worker_profiles.skills`
 *      and `job_postings.skill_ids` — are sent to the ai-service `POST
 *      /skills/retag-plan` (pure compute: chain resolution, cycle drop, first-seen
 *      dedupe). Response is re-validated here (SG-5: every "after" id must be a sent
 *      terminal or an untouched original — nothing invented).
 *   3. REPORT: a dry-run change report is written to
 *      docs/registers/skill-retag-report.md (ids + row uuids only — no PII, no free
 *      text) and printed. DRY-RUN IS THE DEFAULT.
 *   4. `--apply`: applies each row change with OPTIMISTIC CONCURRENCY (`WHERE ids =
 *      before`) — a row that moved since planning is SKIPPED and reported; re-run to
 *      re-plan it. Also MOVES the deprecated skills' aliases to the terminal skill
 *      (insert-with-new-deterministic-id copying the embedding + the terminal's
 *      domain_id, ON CONFLICT DO NOTHING, then delete the old row) so future
 *      canonicalization assigns the successor — without this the live path keeps
 *      emitting the deprecated id forever.
 *
 * IMMUTABILITY (SG-5): ids are never reused/renamed; `skill` rows are never deleted.
 * GUARDED: refuses NODE_ENV === "production" (prod re-tag is a deliberate, gated step).
 *
 *   pnpm db:retag:skills            # dry-run (report only)
 *   pnpm db:retag:skills --apply    # apply row changes + alias moves
 *   (DATABASE_URL from env/.env; AI_SERVICE_URL defaults to http://localhost:8000;
 *    RETAG_REPORT_PATH overrides the report location.)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { createDbClient } from "./client";
import { jobPostings, skillAliases, skills, workerProfiles } from "./schema";
import { deterministicAliasId } from "./skill-alias-id";

config({ path: "../../.env" });

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Request caps — MUST match the Pydantic/Zod RetagPlanInput caps. */
const MAX_ROWS_PER_REQUEST = 5000;
const MAX_CROSSWALK = 1000;
/** Cap the per-row listing in the report (counts are always exact). */
const MAX_REPORT_ROWS = 200;

interface ResolvedEntry {
  deprecated_id: string;
  terminal_id: string;
  hops: number;
}
interface Change {
  row_ref: string;
  before: string[];
  after: string[];
}
interface RetagPlan {
  resolved: ResolvedEntry[];
  dropped: string[];
  changes: Change[];
  rows_in: number;
  rows_changed: number;
}

/** Validate the /skills/retag-plan response: shape + the SG-5 property — every "after"
 * id must be either an id that row already had or a terminal WE derived from the
 * crosswalk we sent. A violation aborts (a re-tag must never write an invented id). */
function parseRetagResponse(
  raw: unknown,
  sentRows: Map<string, string[]>,
  sentCrosswalkKeys: Set<string>,
): RetagPlan {
  const bad = (why: string): never => {
    throw new Error(`[retag] malformed ai-service response — ${why}`);
  };
  if (typeof raw !== "object" || raw === null) bad("not an object");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.resolved) || !Array.isArray(o.dropped) || !Array.isArray(o.changes)) {
    bad("resolved/dropped/changes missing");
  }
  const resolved: ResolvedEntry[] = [];
  const terminals = new Set<string>();
  for (const r of o.resolved as unknown[]) {
    const it = r as Record<string, unknown>;
    if (
      typeof it?.deprecated_id !== "string" ||
      typeof it?.terminal_id !== "string" ||
      typeof it?.hops !== "number"
    ) {
      bad("resolved entry malformed");
    }
    if (!sentCrosswalkKeys.has(it.deprecated_id as string)) {
      bad(`resolved deprecated_id ${String(it.deprecated_id)} was not in the sent crosswalk`);
    }
    if (sentCrosswalkKeys.has(it.terminal_id as string)) {
      bad(`terminal ${String(it.terminal_id)} is itself a crosswalk key (not terminal)`);
    }
    terminals.add(it.terminal_id as string);
    resolved.push(it as unknown as ResolvedEntry);
  }
  const changes: Change[] = [];
  for (const c of o.changes as unknown[]) {
    const it = c as Record<string, unknown>;
    if (typeof it?.row_ref !== "string" || !sentRows.has(it.row_ref as string)) {
      bad(`change row_ref ${String(it?.row_ref)} was not in the request`);
    }
    if (!Array.isArray(it.before) || !Array.isArray(it.after)) bad("before/after malformed");
    const sentIds = sentRows.get(it.row_ref as string) ?? [];
    const beforeArr = it.before as unknown[];
    if (
      beforeArr.length !== sentIds.length ||
      !beforeArr.every((v, i) => typeof v === "string" && v === sentIds[i])
    ) {
      bad(`change for ${String(it.row_ref)} reports a "before" we did not send`);
    }
    for (const id of it.after as unknown[]) {
      // SG-5: after ⊆ (original ids ∪ derived terminals) — nothing invented.
      if (typeof id !== "string" || (!sentIds.includes(id) && !terminals.has(id))) {
        bad(
          `after id ${String(id)} for ${String(it.row_ref)} is neither original nor a terminal (SG-5)`,
        );
      }
    }
    changes.push({
      row_ref: it.row_ref as string,
      before: sentIds,
      after: it.after as string[],
    });
  }
  return {
    resolved,
    dropped: (o.dropped as unknown[]).filter((d): d is string => typeof d === "string"),
    changes,
    rows_in: typeof o.rows_in === "number" ? o.rows_in : 0,
    rows_changed: typeof o.rows_changed === "number" ? o.rows_changed : 0,
  };
}

interface Surface {
  name: "worker_profiles" | "job_postings";
  fetch: () => Promise<{ id: string; ids: string[] }[]>;
  applyOne: (rowId: string, before: string[], after: string[]) => Promise<boolean>;
}

async function planSurface(
  aiBase: string,
  crosswalk: { deprecated_id: string; replaced_by: string }[],
  rows: { id: string; ids: string[] }[],
): Promise<RetagPlan> {
  const merged: RetagPlan = { resolved: [], dropped: [], changes: [], rows_in: 0, rows_changed: 0 };
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_REQUEST) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_REQUEST);
    const resp = await fetch(`${aiBase}/skills/retag-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        crosswalk,
        rows: chunk.map((r) => ({ row_ref: r.id, skill_ids: r.ids })),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`[retag] ai-service HTTP ${resp.status} on plan — aborting`);
    const plan = parseRetagResponse(
      await resp.json(),
      new Map(chunk.map((r) => [r.id, r.ids])),
      new Set(crosswalk.map((c) => c.deprecated_id)),
    );
    merged.resolved = plan.resolved; // identical across chunks (same crosswalk)
    merged.dropped = plan.dropped;
    merged.changes.push(...plan.changes);
    merged.rows_in += plan.rows_in;
    merged.rows_changed += plan.rows_changed;
  }
  return merged;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[retag] refusing to run in production (run is §7-gated ops).");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[retag] DATABASE_URL is not set");
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const apply = process.argv.includes("--apply");
  const reportPath =
    process.env.RETAG_REPORT_PATH ??
    path.resolve(__dirname, "../../../docs/registers/skill-retag-report.md");

  const { db, sql: pg } = createDbClient(url, { max: 1 });
  try {
    // 1) Crosswalk from the skill table (status machine lives in the corpus → seed).
    const deprecated = await db
      .select({ skillId: skills.skillId, replacedBy: skills.replacedBy })
      .from(skills)
      .where(and(eq(skills.status, "deprecated"), isNotNull(skills.replacedBy)))
      .orderBy(skills.skillId);
    if (deprecated.length > MAX_CROSSWALK) {
      throw new Error(`[retag] crosswalk ${deprecated.length} exceeds the ${MAX_CROSSWALK} cap`);
    }
    if (deprecated.length === 0) {
      console.log("[retag] no deprecated skills with a successor — nothing to do.");
      return;
    }
    // Dead-end guard: a terminal that is itself deprecated WITHOUT a successor would
    // re-tag rows onto a retired id — exclude those chains fail-safe.
    const allSkills = await db
      .select({ skillId: skills.skillId, status: skills.status, replacedBy: skills.replacedBy, domainId: skills.domainId })
      .from(skills);
    const byId = new Map(allSkills.map((s) => [s.skillId, s]));
    const keys = new Set(deprecated.map((d) => d.skillId));
    const deadEnd = (start: string): boolean => {
      let cur = start;
      const seen = new Set<string>();
      while (keys.has(cur)) {
        if (seen.has(cur)) return false; // cycle — the service drops it
        seen.add(cur);
        cur = byId.get(cur)?.replacedBy ?? "";
      }
      const terminal = byId.get(cur);
      return terminal === undefined || terminal.status === "deprecated";
    };
    const excluded = deprecated.filter((d) => deadEnd(d.skillId)).map((d) => d.skillId);
    const crosswalk = deprecated
      .filter((d) => !excluded.includes(d.skillId))
      .map((d) => ({ deprecated_id: d.skillId, replaced_by: d.replacedBy as string }));
    if (excluded.length > 0) {
      console.log(
        `[retag] WARNING: ${excluded.length} crosswalk id(s) excluded — their chain dead-ends ` +
          `on a deprecated/missing terminal (fix the corpus): ${excluded.join(", ")}`,
      );
    }
    if (crosswalk.length === 0) {
      console.log("[retag] every crosswalk chain dead-ends — nothing safe to re-tag.");
      return;
    }
    const deprecatedIds = crosswalk.map((c) => c.deprecated_id);

    // 2) Affected rows per surface (jsonb string-array overlap via ?|).
    const surfaces: Surface[] = [
      {
        name: "worker_profiles",
        fetch: async () =>
          (
            await db
              .select({ id: workerProfiles.id, ids: workerProfiles.skills })
              .from(workerProfiles)
              .where(sql`${workerProfiles.skills} ?| ${deprecatedIds}`)
              .orderBy(workerProfiles.id)
          ).map((r) => ({ id: r.id, ids: r.ids })),
        applyOne: async (rowId, before, after) => {
          const updated = await db
            .update(workerProfiles)
            .set({ skills: after })
            .where(
              and(
                eq(workerProfiles.id, rowId),
                sql`${workerProfiles.skills} = ${JSON.stringify(before)}::jsonb`,
              ),
            )
            .returning({ id: workerProfiles.id });
          return updated.length === 1;
        },
      },
      {
        name: "job_postings",
        fetch: async () =>
          (
            await db
              .select({ id: jobPostings.id, ids: jobPostings.skillIds })
              .from(jobPostings)
              .where(sql`${jobPostings.skillIds} ?| ${deprecatedIds}`)
              .orderBy(jobPostings.id)
          ).map((r) => ({ id: r.id, ids: r.ids })),
        applyOne: async (rowId, before, after) => {
          const updated = await db
            .update(jobPostings)
            .set({ skillIds: after })
            .where(
              and(
                eq(jobPostings.id, rowId),
                sql`${jobPostings.skillIds} = ${JSON.stringify(before)}::jsonb`,
              ),
            )
            .returning({ id: jobPostings.id });
          return updated.length === 1;
        },
      },
    ];

    const reportLines: string[] = [
      "# Skill re-tag report (ADR-0030 / TAX-9) — GENERATED",
      "",
      `> Generated by \`pnpm db:retag:skills\` at ${new Date().toISOString()} — ` +
        `${apply ? "**APPLY RUN**" : "**DRY RUN** (no row was changed)"}. ` +
        "Ids + row uuids only — no PII, no free text.",
      "",
      "## Crosswalk",
      "",
      ...crosswalk.map((c) => {
        const t = byId.get(c.replaced_by);
        return `- \`${c.deprecated_id}\` → \`${c.replaced_by}\`${t && keys.has(c.replaced_by) ? " (chain — service resolves the terminal)" : ""}`;
      }),
      ...(excluded.length > 0
        ? ["", `Excluded dead-end chains (fix the corpus): ${excluded.map((e) => `\`${e}\``).join(", ")}`]
        : []),
      "",
    ];

    let totalChanges = 0;
    const applyStats: string[] = [];
    for (const surface of surfaces) {
      const rows = await surface.fetch();
      const plan = await planSurface(aiBase, crosswalk, rows);
      totalChanges += plan.changes.length;
      console.log(
        `[retag] ${surface.name}: scanned=${rows.length} changes=${plan.changes.length} ` +
          `dropped_cyclic=${plan.dropped.length}`,
      );
      reportLines.push(
        `## ${surface.name}`,
        "",
        `Scanned ${rows.length} affected row(s) → ${plan.changes.length} change(s).` +
          (plan.dropped.length > 0
            ? ` Crosswalk ids dropped as CYCLIC by the planner (fix the corpus): ${plan.dropped.map((d) => `\`${d}\``).join(", ")}.`
            : ""),
        "",
      );
      for (const c of plan.changes.slice(0, MAX_REPORT_ROWS)) {
        reportLines.push(`- \`${c.row_ref}\`: [${c.before.join(", ")}] → [${c.after.join(", ")}]`);
      }
      if (plan.changes.length > MAX_REPORT_ROWS) {
        reportLines.push(`- … ${plan.changes.length - MAX_REPORT_ROWS} more (counts above are exact)`);
      }
      reportLines.push("");

      if (apply && plan.changes.length > 0) {
        let applied = 0;
        let skewed = 0;
        for (const c of plan.changes) {
          const ok = await surface.applyOne(c.row_ref, c.before, c.after);
          if (ok) applied += 1;
          else skewed += 1;
        }
        applyStats.push(
          `${surface.name}: applied=${applied} skipped_concurrent=${skewed}`,
        );
        if (skewed > 0) {
          console.log(
            `[retag] ${surface.name}: ${skewed} row(s) changed since planning — skipped; re-run to re-plan them.`,
          );
        }
      }
    }

    // 3) Alias moves (apply only): re-point the deprecated skills' aliases to their
    //    terminal so future canonicalization assigns the successor. New deterministic
    //    id + the TERMINAL's domain_id; embedding copied (no re-embed); old row deleted.
    const terminalOf = new Map<string, string>();
    for (const c of crosswalk) {
      let cur = c.deprecated_id;
      const seen = new Set<string>();
      while (keys.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = byId.get(cur)?.replacedBy ?? cur;
      }
      terminalOf.set(c.deprecated_id, cur);
    }
    const aliasRows = await db
      .select()
      .from(skillAliases)
      .where(inArray(skillAliases.skillId, deprecatedIds))
      .orderBy(skillAliases.id);
    reportLines.push(
      "## skill_alias moves",
      "",
      `${aliasRows.length} alias row(s) point at deprecated ids` +
        (apply ? " — moved to their terminals (embedding copied)." : " — WOULD move under --apply."),
      "",
    );
    if (apply) {
      let moved = 0;
      for (const a of aliasRows) {
        const terminal = terminalOf.get(a.skillId);
        if (terminal === undefined) continue;
        const targetDomain = byId.get(terminal)?.domainId ?? a.domainId;
        await db
          .insert(skillAliases)
          .values({
            id: deterministicAliasId(terminal, a.text, a.lang),
            skillId: terminal,
            text: a.text,
            lang: a.lang,
            source: a.source,
            domainId: targetDomain,
            embedding: a.embedding,
          })
          .onConflictDoNothing({ target: skillAliases.id });
        await db.delete(skillAliases).where(eq(skillAliases.id, a.id));
        moved += 1;
      }
      applyStats.push(`skill_alias: moved=${moved}`);
    }

    if (apply) {
      reportLines.push("## Apply summary", "", ...applyStats.map((s) => `- ${s}`), "");
    }
    writeFileSync(reportPath, reportLines.join("\n") + "\n", "utf8");
    console.log(`[retag] report written → ${reportPath}`);
    console.log(
      apply
        ? `[retag] APPLY complete — ${applyStats.join(" · ") || "nothing to apply"}`
        : `[retag] DRY RUN — ${totalChanges} row change(s) planned; re-run with --apply to perform them.`,
    );
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
