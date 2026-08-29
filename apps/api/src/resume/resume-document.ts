import { TRADE_RESUME_MAPS } from "./trade-resume-map";
import type {
  ResumeEmployment,
  ResumeFactRow,
  ResumeListRow,
  ResumeRenderInput,
} from "./resume-renderer.service";

/**
 * THE RESUME AS STRUCTURED DATA, for a client that draws it rather than prints it.
 *
 * WHAT THIS REPLACES. The worker app renders its résumé screen by parsing `resume_text` for
 * `Label: value` lines. That is a second renderer, written in Dart, reverse-engineering a string
 * built for humans — so the screen and the PDF are free to disagree about what a worker's résumé
 * says, and they do: the app's section list has four buckets and everything else falls into a
 * trailing "More". This projects the SAME input the template consumes, so the two cannot drift.
 *
 * ── TWO FORMATS, N TRADES ──────────────────────────────────────────────────────────────────
 *
 * `format` is what the client SWITCHES ON and there are exactly two, because there are exactly
 * two layouts: the twelve `classic`/`modern`/`minimal`/`fallback` layouts all render the same
 * flat set of slots, and `bb_trade` renders zoned rows. `trade` is what the client LABELS with,
 * and it is open-ended.
 *
 * That split is the scalability property, and it is deliberate: adding the next trade adds a pack,
 * a resume map and a `trade` value — and NO client branch, because a welder's sheet is the same
 * shape as a turner's with different rows in it. A union keyed on the trade instead would make
 * every new trade a new case in Dart, which is the thing "scalable" has to rule out.
 */

/** The layouts a client must be able to draw. Two, and adding a trade does not add a third. */
export const RESUME_FORMATS = ["generic", "trade_sheet"] as const;
export type ResumeFormat = (typeof RESUME_FORMATS)[number];

/**
 * Which trade's sheet this is, when it is one.
 *
 * DERIVED FROM THE PACK, not stored and not asked. `TRADE_RESUME_MAPS` already answers "does this
 * pack have a sheet", and a second list of trade ids would be free to disagree with it — a pack
 * with a map but no id here would render a sheet the client could not name.
 */
export const TRADE_KIND_BY_PACK: Readonly<Record<string, string>> = {
  qp_cnc_turning: "cnc_turner",
  qp_vmc_milling: "vmc_milling",
};

/** Does this pack print the trade sheet? */
export function packHasTradeSheet(packId: string | null): boolean {
  return packId !== null && TRADE_RESUME_MAPS.some((map) => map.pack_id === packId);
}

/**
 * The template a worker's résumé renders through.
 *
 * GATED ON THE PACK HAVING A MAP, which is the same condition the capability rows already use.
 * A worker whose trade has no map keeps `classic` and renders byte-identically to yesterday —
 * so this flips workers over one at a time as their trade is authored, with no cutover and no
 * backfill, exactly as the work-history reader was staged.
 */
export function templateIdForPack(packId: string | null): string {
  return packHasTradeSheet(packId) ? "bb_trade" : "classic";
}

export function tradeKindForPack(packId: string | null): string | null {
  if (!packHasTradeSheet(packId) || packId === null) return null;
  // A pack with a sheet but no name still gets a sheet — it is a labelling gap, not a render
  // fault, and refusing to render one would be a worse answer than a generic label.
  return TRADE_KIND_BY_PACK[packId] ?? "trade";
}

// ── the document ─────────────────────────────────────────────────────────────────────────────

export interface ResumeDocumentHeader {
  readonly name: string | null;
  readonly phone: string | null;
  /** The masthead's right-hand slot; null when the worker has no attestation. */
  readonly trustBadge: string | null;
}

export interface ResumeDocumentSection {
  readonly id: string;
  readonly title: string;
  /** Chip rows — a label and a list drawn as pills. */
  readonly chipRows: readonly ResumeListRow[];
  /** Tick rows — a label and a list drawn as ✓ items. */
  readonly tickRows: readonly ResumeListRow[];
  /** Fact rows — a label and one value. */
  readonly factRows: readonly ResumeFactRow[];
}

interface ResumeDocumentBase {
  readonly header: ResumeDocumentHeader;
  /**
   * The masthead-matching footer line the sheet prints ("Generated 27 August 2026 · Ref RK8M2Q").
   *
   * ONE FIELD, because the template has one slot. The QR image and the standing disclaimer are
   * drawn by the layout rather than supplied to it, so a document that carried them would be
   * asserting facts the render input does not hold.
   */
  readonly footerMeta: string | null;
}

export interface GenericResumeDocument extends ResumeDocumentBase {
  readonly format: "generic";
  readonly trade: null;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly location: string | null;
  readonly availability: string | null;
  readonly experienceYears: number | null;
  readonly expectedSalary: number | null;
  readonly skills: readonly string[];
  readonly machines: readonly string[];
  readonly controllers: readonly string[];
  readonly education: readonly string[];
  readonly certifications: readonly string[];
  readonly preferredLocations: readonly string[];
  readonly experiences: ResumeRenderInput["experiences"];
}

export interface TradeSheetResumeDocument extends ResumeDocumentBase {
  readonly format: "trade_sheet";
  readonly trade: string;
  /** The two-line verdict — role · years · machines, then city · availability · salary. */
  readonly headline: { readonly line1: string | null; readonly line2: string | null };
  readonly sections: readonly ResumeDocumentSection[];
  readonly employments: readonly ResumeEmployment[];
  /** "and 2 more" when the block budget truncated the history. */
  readonly employmentsMore: string | null;
}

export type ResumeDocument = GenericResumeDocument | TradeSheetResumeDocument;

/**
 * Project a render input into the document a client draws.
 *
 * PURE, and reading ONLY the input the template reads. Anything it had to fetch for itself would
 * be a fact the screen could hold and the PDF could not, which is the drift this exists to end.
 */
export function toResumeDocument(input: ResumeRenderInput, packId: string | null): ResumeDocument {
  const header: ResumeDocumentHeader = {
    name: input.displayName ?? null,
    phone: input.phone ?? null,
    trustBadge: input.trustBadge ?? null,
  };
  const footerMeta = input.footerMeta ?? null;

  const trade = tradeKindForPack(packId);
  if (trade === null) {
    return {
      format: "generic",
      trade: null,
      header,
      footerMeta,
      headline: input.canonicalRole,
      summary: input.summary,
      location: input.location,
      availability: input.availability,
      experienceYears: input.experienceYears,
      expectedSalary: input.expectedSalary,
      skills: input.skills,
      machines: input.machines,
      controllers: input.controllers,
      education: input.education,
      certifications: input.certifications,
      preferredLocations: input.preferredLocations,
      experiences: input.experiences,
    };
  }

  return {
    format: "trade_sheet",
    trade,
    header,
    footerMeta,
    headline: { line1: input.headlineLine ?? null, line2: input.subheadLine ?? null },
    // THE SHEET'S OWN ZONES, in the order it prints them. A section with no rows is kept rather
    // than dropped: the client decides whether an empty zone shows a heading, and dropping it
    // here would take that decision away from the surface that can see the screen.
    sections: [
      {
        id: "capability",
        title: input.capSectionTitle ?? "Capability",
        chipRows: input.capChipRows ?? [],
        tickRows: input.capTickRows ?? [],
        factRows: input.capFactRows ?? [],
      },
      {
        id: "terms",
        title: "Availability & terms",
        chipRows: [],
        tickRows: [],
        factRows: input.availFactRows ?? [],
      },
      {
        id: "qualifications",
        title: "Qualification, documents & languages",
        chipRows: [],
        tickRows: input.qualTickRows ?? [],
        factRows: input.qualFactRows ?? [],
      },
    ],
    employments: input.employments ?? [],
    employmentsMore: input.employmentsMore ?? null,
  };
}
