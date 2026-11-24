/**
 * `db:report:trade-codes` — where every trade's NCO-2015 codes resolve today (#3028).
 *
 * READ-ONLY, AND NO DATABASE. The pack's section 13.1 lists occupation codes for all 60
 * trades; section 13.3 says a live binding wins and the list is for checking only. This
 * script answers the check against the files the engine actually reads:
 *
 *   - `TRADE_CATALOGUE.ncoCodes` — the pack's proposed list per trade (#2998);
 *   - `_families.jsonl` — the family bindings;
 *   - `question-pack-resolver.ts` — the same most-specific-wins resolver the interview uses;
 *   - `nco2015.jsonl` — the code's English title and description.
 *
 * OUTPUT. A markdown table for all 60 trades, the 16 live-trade table to post on #2995
 * (point 14), the shared-code table, the generic-title descriptions section 13.3.6 asks a
 * person to read, and PASS/FAIL rule checks. The rule checks are the gate: any breach exits
 * non-zero.
 *
 * WHAT DOES NOT FAIL. A code the pack lists under one trade but a live family holds is a
 * DIFFERENCE, not a breach: section 13.1 says do not rebind a live family. The report shows
 * it; #2995 gets it. A code listed under two trades is allowed only where one of those two
 * trades owns the live family (the five contested codes #2995 point 4 resolves).
 *
 * PRIVACY: published occupation reference data. No worker or company data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JOB_ROLE_LABELS, type TradeFormKindName } from "@badabhai/types";
import { LOADED_WAVE, TRADE_CATALOGUE, type TradeCatalogueEntry } from "@badabhai/taxonomy";

import { jobDomainIdFor, loadJobDomainCorpus, type JobDomainSeedRecord } from "./job-domain-corpus";
import { loadQuestionPackCorpus, type BindingRecord } from "./question-pack-corpus";
import { resolveFamily, type ResolvableBinding } from "./question-pack-resolver";

const SCRIPT = "report:trade-codes";

/**
 * Codes that must appear on NO trade in section 13.1.
 *
 * Jewellery (13.3.5), the PLC-hardware assembler and the medical X-ray title (13.2), and the
 * four codes section 13.3.7 leaves unbound on purpose. A code here is a breach, not a report.
 */
export const BOUND_TO_NO_TRADE: ReadonlyMap<string, string> = new Map([
  ["8189.0301", "CAM Machine Operator belongs to Gem and Jewellery (13.3.5)"],
  ["8189.0701", "Pantograph Machine Operator belongs to Gem and Jewellery (13.3.5)"],
  ["8212.2002", "PLC Assembly Operator assembles PLC hardware, not automation (13.2)"],
  ["3211.0100", "X-Ray Technician is medical, not NDT (13.2)"],
  ["2144.0100", "Mechanical Engineer, General is left unbound on purpose (13.3.7)"],
  ["3118.0301", "Draftsman is left unbound on purpose (13.3.7)"],
  ["2166.0401", "Designer (CAD) is left unbound on purpose (13.3.7)"],
  ["2144.0802", "Modeller is left unbound on purpose (13.3.7)"],
]);

/** The three generic CNC operator titles: at most one form may list each (13.2). */
export const GENERIC_CNC_TITLES = ["7223.5001", "7223.5002", "7223.5003"] as const;

/** Section 13.3.6: a person reads the description before these stay bound. */
export const GENERIC_TITLED_CODES = [
  "7543.0701",
  "7543.0702",
  "7543.3002",
  "7543.3004",
  "7543.3005",
  "8142.0502",
  "3113.0401",
  "3113.0601",
] as const;

export interface TradeCodeRow {
  tradeCode: string;
  tradeLabel: string;
  roleKind: string;
  tradeFamilyId: string;
  wave: number;
  loaded: boolean;
  code: string;
  title: string;
  description: string;
  resolvedFamilyId: string;
  familyLabel: string;
  matchedOn: string;
  ownFamily: boolean;
  /**
   * `pack` — a code section 13.1 lists for this trade.
   * `live-only` — a live binding the catalogue carries (`ncoCodes`) that the pack does not list.
   * The live 16 `ncoCodes` are live bindings by #2998; the pack's list is the report's subject.
   */
  source: "pack" | "live-only";
}

interface PackCode {
  code: string;
  title: string;
}

export interface SharedCodeRow {
  code: string;
  title: string;
  trades: string;
  resolvedFamilyId: string;
  /** True when one of the listed trades owns the resolved family. */
  ownedByListedTrade: boolean;
}

export interface GenericTitleRow {
  code: string;
  title: string;
  description: string;
  trades: string;
}

export interface RuleCheck {
  label: string;
  ok: boolean;
  problems: readonly string[];
}

export interface TradeCodeReport {
  rows: TradeCodeRow[];
  liveRows: TradeCodeRow[];
  /** Live bindings the catalogue carries that section 13.1 does not list. */
  liveExtras: TradeCodeRow[];
  shared: SharedCodeRow[];
  genericTitles: GenericTitleRow[];
  ruleChecks: RuleCheck[];
  problems: string[];
  /** Live pack rows whose live family is not the trade's own family. */
  differences: TradeCodeRow[];
}

/** The same target precedence as `bindingSpecificity`, for the two-families-one-target check. */
function bindingTarget(b: BindingRecord): string | null {
  if (b.job_domain_id) return `job_domain:${b.job_domain_id}`;
  if (b.isco_unit_code) return `unit:${b.isco_unit_code}`;
  if (b.isco_minor_code) return `minor:${b.isco_minor_code}`;
  if (b.isco_submajor_code) return `submajor:${b.isco_submajor_code}`;
  if (b.isco_major_code) return `major:${b.isco_major_code}`;
  if (b.is_universal) return "universal";
  return null;
}

/** A corpus binding in the shape the engine's resolver consumes. */
function resolvable(b: BindingRecord): ResolvableBinding {
  return {
    familyId: b.family_id,
    jobDomainId: b.job_domain_id,
    iscoUnitCode: b.isco_unit_code,
    iscoMinorCode: b.isco_minor_code,
    iscoSubmajorCode: b.isco_submajor_code,
    iscoMajorCode: b.isco_major_code,
    isUniversal: b.is_universal,
  };
}

function tradeLabel(e: TradeCatalogueEntry): string {
  return `${e.code} ${JOB_ROLE_LABELS[e.roleKind as TradeFormKindName]?.label ?? e.roleKind}`;
}

/**
 * Section 13.1's code list per trade. The catalogue's live `ncoCodes` are today's live
 * bindings (byte-identical to the family corpus, #2998), not the pack's proposal; the
 * report needs the proposal to answer "where does the live system differ".
 */
export function loadPackCodes(): Map<string, PackCode[]> {
  const path = join(
    __dirname,
    "..",
    "..",
    "..",
    "docs",
    "reference",
    "BadaBhai_Manufacturing_Taxonomy_and_Question_Pack_v2.md",
  );
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const byTrade = new Map<string, PackCode[]>();
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("### 13.1 ")) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("### 13.2 ")) break;
    if (!inSection || !line.startsWith("| T")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const tradeCode = cells[1] ?? "";
    if (!/^T\d{2}$/.test(tradeCode)) continue;
    const codes = (cells[5] ?? "")
      .split("<br>")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const m = part.match(/^(\d{4}\.\d{4})\s+(.+)$/);
        return m?.[1] === undefined ? null : { code: m[1], title: m[2] ?? "" };
      })
      .filter((c): c is PackCode => c !== null);
    byTrade.set(tradeCode, codes);
  }
  return byTrade;
}

/**
 * Build the report from the committed files. Pure enough to test: it reads only the corpus
 * loaders (no database, no network).
 */
export function buildTradeCodeReport(): TradeCodeReport {
  const nco = loadJobDomainCorpus().filter(
    (r): r is JobDomainSeedRecord & { code: string } => r.source === "nco2015" && r.code !== null,
  );
  const ncoByCode = new Map(nco.map((r) => [r.code, r]));
  const packCorpus = loadQuestionPackCorpus();
  const bindings = packCorpus.bindings.map(resolvable);
  const familyLabel = new Map(packCorpus.families.map((f) => [f.family_id, f.label_en]));
  const missing: string[] = [];
  const forbidden: string[] = [];
  const genericCnc: string[] = [];
  const sharedProblems: string[] = [];
  const bindingProblems: string[] = [];

  const rows: TradeCodeRow[] = [];
  const tradesByCode = new Map<
    string,
    { trade: TradeCatalogueEntry; source: "pack" | "live-only" }[]
  >();
  const packCodes = loadPackCodes();

  for (const e of TRADE_CATALOGUE) {
    const proposed = packCodes.get(e.code) ?? [];
    const proposedSet = new Set(proposed.map((p) => p.code));
    const entries: { code: string; source: "pack" | "live-only" }[] = [
      ...proposed.map((p) => ({ code: p.code, source: "pack" as const })),
      ...e.ncoCodes
        .filter((code) => !proposedSet.has(code))
        .map((code) => ({ code, source: "live-only" as const })),
    ];
    for (const { code, source } of entries) {
      const record = ncoByCode.get(code);
      tradesByCode.set(code, [...(tradesByCode.get(code) ?? []), { trade: e, source }]);
      if (record === undefined) {
        missing.push(`${e.code} ${source} lists ${code}, which is not in nco2015.jsonl`);
        continue;
      }
      const resolution = resolveFamily(bindings, {
        jobDomainId: jobDomainIdFor(record),
        iscoUnitCode: record.isco_unit,
      });
      if (resolution === null) {
        missing.push(`${e.code} ${code} resolves to no family at all (not even universal)`);
        continue;
      }
      rows.push({
        tradeCode: e.code,
        tradeLabel: tradeLabel(e),
        roleKind: e.roleKind,
        tradeFamilyId: e.familyId,
        wave: e.wave,
        loaded: e.wave <= LOADED_WAVE,
        code,
        title: record.label_en,
        description: record.description_en ?? "",
        resolvedFamilyId: resolution.familyId,
        familyLabel: familyLabel.get(resolution.familyId) ?? resolution.familyId,
        matchedOn: resolution.matchedOn,
        ownFamily: resolution.familyId === e.familyId,
        source,
      });
    }
  }

  // ── Rule 1: a binding target belongs to one family (the corpus validator's twin) ─────
  const claimedTargets = new Map<string, string>();
  for (const b of packCorpus.bindings) {
    const target = bindingTarget(b);
    if (target === null) {
      bindingProblems.push(`binding ${b.family_id} sets no target`);
      continue;
    }
    const prior = claimedTargets.get(target);
    if (prior !== undefined && prior !== b.family_id) {
      bindingProblems.push(`binding target ${target} is claimed by ${prior} and ${b.family_id}`);
    }
    claimedTargets.set(target, b.family_id);
  }

  // ── Rule 2: the codes section 13 sends to no trade ───────────────────────────────────
  for (const [code, why] of BOUND_TO_NO_TRADE) {
    const listed = tradesByCode.get(code) ?? [];
    if (listed.length > 0) {
      forbidden.push(
        `${code} is listed under ${listed.map((t) => t.trade.code).join(", ")} — ${why}`,
      );
    }
  }

  // ── Rule 3: the generic CNC titles stay on at most one form ──────────────────────────
  for (const code of GENERIC_CNC_TITLES) {
    const listed = tradesByCode.get(code) ?? [];
    if (listed.length > 1) {
      genericCnc.push(
        `${code} is listed under ${listed.map((t) => t.trade.code).join(", ")} — a generic CNC ` +
          `title may be bound to no second form (13.2)`,
      );
    }
  }

  // ── Rule 4: one code, one family; two trades only where one owns the live family ────
  const shared: SharedCodeRow[] = [];
  for (const [code, trades] of tradesByCode) {
    const listed = trades.map((t) => `${t.trade.code} (${t.source})`);
    if (trades.length > 2) {
      sharedProblems.push(
        `${code} is listed under ${listed.join(", ")} — at most two trades may share one code`,
      );
    }
    if (trades.length === 2) {
      const resolved = rows.find((r) => r.code === code)?.resolvedFamilyId;
      const owned =
        resolved !== undefined && trades.some((t) => t.trade.familyId === resolved);
      shared.push({
        code,
        title: ncoByCode.get(code)?.label_en ?? "(not in corpus)",
        trades: listed.join(", "),
        resolvedFamilyId: resolved ?? "(unresolved)",
        ownedByListedTrade: owned,
      });
      if (!owned) {
        sharedProblems.push(
          `${code} is listed under ${listed.join(", ")} but its live family ${resolved} owns neither trade`,
        );
      }
    }
  }

  const genericTitles: GenericTitleRow[] = GENERIC_TITLED_CODES.map((code) => {
    const trades = tradesByCode.get(code) ?? [];
    return {
      code,
      title: ncoByCode.get(code)?.label_en ?? "(not in corpus)",
      description: ncoByCode.get(code)?.description_en ?? "(not in corpus)",
      trades:
        trades.length === 0
          ? "(no trade lists it)"
          : trades.map((t) => `${t.trade.code} (${t.source})`).join(", "),
    };
  });

  const liveRows = rows.filter((r) => r.loaded);
  const liveExtras = liveRows.filter((r) => r.source === "live-only");
  const differences = liveRows.filter((r) => r.source === "pack" && !r.ownFamily);
  const ruleChecks: RuleCheck[] = [
    {
      label: "every pack or live-only code is in the NCO corpus and resolves to one family",
      ok: missing.length === 0,
      problems: missing,
    },
    {
      label: "no code section 13 sends to no trade is listed",
      ok: forbidden.length === 0,
      problems: forbidden,
    },
    {
      label: "the generic CNC titles are on at most one form",
      ok: genericCnc.length === 0,
      problems: genericCnc,
    },
    {
      label: "one code, one family; a shared code is owned by a listed trade",
      ok: sharedProblems.length === 0,
      problems: sharedProblems,
    },
    {
      label: "no binding target is claimed by two families",
      ok: bindingProblems.length === 0,
      problems: bindingProblems,
    },
  ];
  return {
    rows,
    liveRows,
    liveExtras,
    shared,
    genericTitles,
    ruleChecks,
    problems: ruleChecks.flatMap((r) => r.problems),
    differences,
  };
}

function renderTable(rows: readonly TradeCodeRow[]): string {
  const lines = [
    "| Trade | List | Code | NCO title | Today's family | Matched on | Own family? |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.tradeLabel} | ${r.source} | ${r.code} | ${r.title} | ${r.resolvedFamilyId} | ${
          r.matchedOn
        } | ${r.ownFamily ? "yes" : "no"} |`,
    ),
  ];
  return lines.join("\n");
}

function renderShared(rows: readonly SharedCodeRow[]): string {
  if (rows.length === 0) return "_No code is listed under two trades._";
  return [
    "| Code | NCO title | Trades | Live family | Owned by a listed trade? |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.code} | ${r.title} | ${r.trades} | ${r.resolvedFamilyId} | ${
          r.ownedByListedTrade ? "yes" : "no"
        } |`,
    ),
  ].join("\n");
}

function renderGenericTitles(rows: readonly GenericTitleRow[]): string {
  return [
    "| Code | NCO title | Pack trade(s) | description_en |",
    "|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.code} | ${r.title} | ${r.trades} | ${r.description.replace(/\|/g, "\\|")} |`,
    ),
  ].join("\n");
}

function renderRules(report: TradeCodeReport): string {
  return report.ruleChecks
    .map(
      (r) =>
        `- ${r.ok ? "PASS" : "FAIL"} — ${r.label}${r.ok ? "" : ` (${r.problems.length} breach(es))`}`,
    )
    .join("\n");
}

export function renderReport(report: TradeCodeReport, opts: { liveOnly?: boolean } = {}): string {
  const header = [
    `# Trade code bindings (#3028)`,
    "",
    `Read-only. ${report.rows.length} code rows over ${TRADE_CATALOGUE.length} trades; ` +
      `LOADED_WAVE=${LOADED_WAVE}.`,
    "",
  ];
  const livePackRows = report.liveRows.filter((r) => r.source === "pack");
  const summary =
    `**${report.differences.length} difference(s) of ${livePackRows.length} live pack rows; ` +
    `${report.liveExtras.length} live-only binding(s) not in section 13.1.**`;
  const liveBlock = [
    "## The 16 live trades — section 13.1 against today's family",
    "",
    "Section 13.1 is **for checking only**. A `no` means the code is listed for this trade " +
      "but a live family holds it today; no binding was changed by this report. `live-only` " +
      "rows are bindings the catalogue carries that section 13.1 does not list.",
    "",
    renderTable(report.liveRows),
    "",
    summary,
    "",
  ];
  if (opts.liveOnly) return [...header, ...liveBlock].join("\n");

  return [
    ...header,
    "## All 60 trades",
    "",
    renderTable(report.rows),
    "",
    ...liveBlock,
    "## Live-only bindings not in section 13.1",
    "",
    report.liveExtras.length === 0
      ? "_None._"
      : renderTable(report.liveExtras),
    "",
    "## Codes listed under two trades (pack or live-only)",
    "",
    renderShared(report.shared),
    "",
    "## Generic-titled codes — read the description before keeping the binding (13.3.6)",
    "",
    renderGenericTitles(report.genericTitles),
    "",
    "## Rule checks",
    "",
    renderRules(report),
    "",
    report.problems.length === 0
      ? "All rule checks passed."
      : ["FAILURES:", ...report.problems.map((p) => `- ${p}`)].join("\n"),
    "",
  ].join("\n");
}

function main(): void {
  const report = buildTradeCodeReport();
  const liveOnly = process.argv.includes("--live");
  console.log(renderReport(report, { liveOnly }));
  if (report.problems.length > 0) {
    console.error(`[${SCRIPT}] ${report.problems.length} rule breach(es).`);
    process.exitCode = 1;
  }
}

// Guarded so importing the helpers for a test does not run the report.
if (process.argv[1] && /report-trade-code-bindings/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level constant; this is the CLI's terminal error line.
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  }
}
