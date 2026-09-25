import { z } from "zod";
import { ROLE_FORM_DESCRIPTORS } from "../profiling/roles/role-registry";
import { QUAL_SECTION_TITLES } from "./resume-tier-headings";
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
 * DERIVED FROM THE PACK, not stored and not asked — and since Layer A (i) EVERY pack has a sheet,
 * so this is a NAME lookup rather than the old "does a map exist" gate. The `?? "trade"` fallback
 * exists for the ~102 packs with no role descriptor: a pack with a sheet but no reviewed name still
 * renders, because a labelling gap is not a render fault.
 *
 * DERIVED FROM THE ROLE REGISTRY: `pack → kind` is the same fact as `kind → pack`, which the
 * registry already holds for routing. `role-registry.ts` asserts pack ids are unique across roles
 * at load, which is what makes the inversion total rather than lossy.
 */
export const TRADE_KIND_BY_PACK: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(ROLE_FORM_DESCRIPTORS.map((role) => [role.packId, role.kind])),
);

/**
 * Does this worker render through the universal trade sheet? (Layer A (i) — "no map, no cliff".)
 *
 * IT USED TO ASK "does this pack have a bespoke capability map?", and the answer decided whether
 * the worker got the BadaBhai sheet at all: ~102 of the 111 packs had no map, so their workers
 * fell back to the flat `classic` layout and lost the verdict line, the terms rows, the
 * qualification rows, the QR and the footer — none of which depends on a map. The map only ever
 * drove Zone 2's per-trade rows, and `buildTradeCapabilityRows` already collapses that section
 * cleanly when no map exists. The cliff was the template gate, not the map.
 *
 * Now the gate is the PACK ITSELF: any pack at all gets the universal sheet. A null pack (a
 * profile with no pack answers, e.g. pre-pack rows) keeps `classic`, which is the only case
 * where the universal sheet has nothing extra to say.
 */
export function packUsesUniversalSheet(packId: string | null): boolean {
  return packId !== null;
}

/**
 * The template a worker's résumé renders through.
 *
 * EVERY PACK GETS `bb_trade` — see `packUsesUniversalSheet` for why the map gate was wrong.
 * The bespoke-map workers are unchanged (same template as before); the no-map families MOVE
 * from `classic` to the universal sheet, which is the cliff this closes.
 */
export function templateIdForPack(packId: string | null): string {
  return packUsesUniversalSheet(packId) ? "bb_trade" : "classic";
}

export function tradeKindForPack(packId: string | null): string | null {
  if (!packUsesUniversalSheet(packId) || packId === null) return null;
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

/**
 * THE RÉSUMÉ AT A GLANCE — what its card in the worker's history prints (#1714):
 *
 *   VMC Operator
 *   Exp: 2 yrs • 3 & 4-axis • Manesar
 *   1 page
 *
 * RECORDED WITH THE RENDER, NOT DERIVED ON READ. A history entry is a record of what was
 * generated THEN — ADR-0043 skips the cosmetic re-render of any entry that is no longer current
 * precisely so it keeps what it was generated with — so its card cannot be filled from the
 * worker's profile TODAY, which may name a different trade and a different city. The document
 * is already the one record written in the same UPDATE as the PDF key, so the card's facts ride
 * it rather than a second write of their own.
 *
 * ONE KNOWN WAY THEY LAG THE FILE. A forced re-render overwrites the PDF at the same key BEFORE
 * that UPDATE; if the upload lands and the UPDATE then fails on the final attempt, the row keeps
 * 'rendered' with the previous document, and so the previous glance, until the next re-render.
 * It needs an infrastructure fault after a good upload, and it predates the glance (the document
 * always lagged the same way).
 *
 * THE FACTS ARE THE VERDICT LINE'S (`ResumeRenderInput.verdictFacts`), normalised as the line
 * prints them. They are recorded even where the sheet omits the line — no role, or the older
 * `classic` layout — so they are that résumé's facts, not a transcript of its paper. `pageCount`
 * is the one fact the input does not hold: the render worker counts it off the PDF's own bytes.
 *
 * ABSENT from every document rendered before #1714; {@link readResumeGlance} reads that as
 * "nothing recorded", never as an empty résumé.
 */
export interface ResumeGlance {
  /** The Verdict Line's role title ("VMC Operator"), or null. */
  readonly role: string | null;
  /** The tenure figure in years; null wherever the Verdict Line would print none. */
  readonly experienceYears: number | null;
  /** The Verdict Line's tools segment — controllers or machines, else skills — at most three. */
  readonly machines: readonly string[];
  /** Machine axes as printed ("3-axis"). Empty for every trade without an axis ask. */
  readonly axes: readonly string[];
  /** The city the Verdict Line's second line was composed with. */
  readonly city: string | null;
  /** Pages in the PDF drawn from this document, or null when they could not be counted. */
  readonly pageCount: number | null;
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
  /** The history card's facts — see {@link ResumeGlance}. */
  readonly glance: ResumeGlance;
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
  /**
   * Each block carries `work` (what PRINTS) and, when a rewrite is what printed,
   * `work_own_words` (what the worker actually wrote) -- see `ResumeEmployment`.
   *
   * BOTH, so a client can show the comparison and offer the choice (#1354). That choice is the
   * only mitigation the section-8 override in #1350 has: no test can assert the absence of a
   * plausible-but-false sentence, and only the worker knows whether one is true.
   */
  readonly employments: readonly ResumeEmployment[];
  /** "and 2 more" when the block budget truncated the history. */
  readonly employmentsMore: string | null;
  /**
   * The TRAINING block a fresher has instead of a work history (#1476).
   *
   * Carried on the sheet as well as on the generic document, because it was not before and the
   * omission had a cost: a fresher's `iti_project_work` sentence printed on the PDF an employer
   * reads while his OWN resume tab showed nothing of it -- so the one person able to say whether
   * a sentence about his training is true could not see it, let alone refuse it.
   *
   * Empty for a worker who has employments; the two are alternatives, never both (see
   * `resume-render-input.ts`'s `experiences`).
   */
  readonly experiences: ResumeRenderInput["experiences"];
}

export type ResumeDocument = GenericResumeDocument | TradeSheetResumeDocument;

/**
 * Project a render input into the document a client draws.
 *
 * PURE, and reading ONLY the input the template reads — plus `pageCount`, which is a fact about
 * the PDF drawn from that input rather than about the input, and so is the caller's to supply.
 * Anything it had to fetch for itself would be a fact the screen could hold and the PDF could
 * not, which is the drift this exists to end.
 */
export function toResumeDocument(
  input: ResumeRenderInput,
  packId: string | null,
  pageCount: number | null = null,
): ResumeDocument {
  const header: ResumeDocumentHeader = {
    name: input.displayName ?? null,
    phone: input.phone ?? null,
    trustBadge: input.trustBadge ?? null,
  };
  const footerMeta = input.footerMeta ?? null;
  const facts = input.verdictFacts;
  const glance: ResumeGlance = {
    role: facts?.role ?? null,
    experienceYears: facts?.years ?? null,
    machines: facts?.tools ?? [],
    axes: facts?.axes ?? [],
    city: facts?.city ?? null,
    pageCount,
  };

  const trade = tradeKindForPack(packId);
  if (trade === null) {
    return {
      format: "generic",
      trade: null,
      header,
      footerMeta,
      glance,
      // Layer A (h): the deterministic headline when the mapper built one, else the role alone —
      // the pre-existing behaviour, so an old server or an old snapshot renders unchanged.
      headline: input.profileHeadline ?? input.canonicalRole,
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
    glance,
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
        title: QUAL_SECTION_TITLES[input.qualSectionVariant ?? "full"],
        chipRows: [],
        tickRows: input.qualTickRows ?? [],
        factRows: input.qualFactRows ?? [],
      },
    ],
    employments: input.employments ?? [],
    employmentsMore: input.employmentsMore ?? null,
    experiences: input.experiences,
  };
}

// ── reading a stored document back ───────────────────────────────────────────────────────────

/**
 * The glance's stored shape, checked field by field. `resume_document` is a `jsonb` column whose
 * rows were written by every build since 0095, so what comes back is validated, never cast.
 */
const StoredGlanceSchema = z.object({
  role: z.string().nullable(),
  experienceYears: z.number().finite().positive().nullable(),
  machines: z.array(z.string()),
  axes: z.array(z.string()),
  city: z.string().nullable(),
  pageCount: z.number().int().positive().nullable(),
});

/**
 * The glance a stored `resume_document` carries, or null when it carries none.
 *
 * NULL IS THE ORDINARY ANSWER for every document rendered before #1714 and for a row that has
 * never rendered — and it is also the answer for a glance that does not validate, because a card
 * showing a malformed fact is worse than a card showing none. It is never an error.
 */
export function readResumeGlance(stored: unknown): ResumeGlance | null {
  if (stored === null || typeof stored !== "object") return null;
  const parsed = StoredGlanceSchema.safeParse((stored as { glance?: unknown }).glance);
  return parsed.success ? parsed.data : null;
}
