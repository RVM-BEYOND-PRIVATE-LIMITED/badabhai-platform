/**
 * `worker_resume_import` — a résumé a worker uploaded, and what we read out of it
 * (ADR-0041, phase RI-1).
 *
 * WHY A TABLE AND NOT JUST AN ANSWER WRITE. The whole point of D2 is that a parsed value is
 * NOT a claim until the worker confirms it. `worker_pack_answer` is the record of what a
 * worker actually said; writing a parsed guess into it would make an abandoned import
 * indistinguishable from an interview, and would put a capability on a man's résumé that he
 * never ticked — the failure §5.3 calls the most damaging available to us. So the parse lands
 * HERE, is offered to him as a suggestion, and only his confirmation writes an answer.
 *
 * That is also why `worker_pack_answer` needs no migration and no new `source` value for this
 * feature: by the time a row reaches it, the source genuinely is `form`.
 *
 * ── SUGGESTIONS ARE ONE ENCRYPTED COLUMN, NOT JSONB ──────────────────────────────────────
 *
 * {@link workerResumeImports.suggestionsEnc} holds the whole parsed payload as a single
 * AES-256-GCM token. A `jsonb` column would have been queryable and pleasant, and it would
 * have been wrong: the payload carries employer names, role titles and free prose lifted from
 * the worker's own document. Encrypting LEAVES instead of the blob is the shape that rots —
 * `parse_masking.py` already has a measured bug of exactly that kind, where a walker missed
 * string leaves nested inside `work_history` arrays and employer names crossed a boundary
 * nobody thought they could reach. One column cannot be partially covered.
 *
 * Nothing reads this except the form/chat prefill path, which decrypts, offers, and forgets.
 *
 * ── RETENTION IS PERMANENT, SO ERASURE IS LOAD-BEARING ───────────────────────────────────
 *
 * D6 keeps the uploaded object indefinitely, which makes ACCOUNT DELETION the only erasure
 * path this feature has. The row goes by `ON DELETE CASCADE`; the OBJECT goes by
 * `deleteByPrefix("resume-uploads/{workerId}/")`, which works only because the key is
 * worker-prefixed — the same property the photo and feedback buckets rely on. A key shape
 * that did not lead with the worker id would silently orphan every résumé on deletion.
 *
 * PRIVACY: worker-authored document content. RLS-locked to the service role like every other
 * worker table. It is never an event payload, never a log line, and the decrypted payload
 * never leaves the request that asked for it.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

import {
  type ResumeExtractionMethodName,
  type ResumeImportFailureName,
  type ResumeImportRouteName,
  type ResumeImportStatusName,
} from "@badabhai/types";

import { workers } from "./worker";

/**
 * THE CLOSED SETS LIVE IN `@badabhai/types`, NOT HERE.
 *
 * `packages/event-schema` needs the identical vocabularies to build its `z.enum(...)` payloads
 * and cannot import this package. Declared in both places they would drift the first time one
 * gained a value, and the symptom would be an event the registry refuses describing a row the
 * database happily stored. So they are declared once, upstream of both.
 */

export const workerResumeImports = pgTable(
  "worker_resume_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** Server-minted, worker-prefixed. The prefix is what makes DSAR erasure possible. */
    storageKey: text("storage_key").notNull(),
    /** Read back from Storage object-info at confirm — never taken from the client's word. */
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),

    status: text("status").$type<ResumeImportStatusName>().notNull().default("uploaded"),
    extractionMethod: text("extraction_method").$type<ResumeExtractionMethodName>(),
    /** 0..1, and only ever set when {@link extractionMethod} is `ocr`. */
    ocrConfidence: real("ocr_confidence"),
    pageCount: integer("page_count"),

    route: text("route").$type<ResumeImportRouteName>(),
    /** A `TradeFormKind`. Set only when {@link route} is `form` — see `wri_form_kind_chk`. */
    formKind: text("form_kind"),

    /** AES-256-GCM token over the staged suggestion payload. NEVER read without PiiCrypto. */
    suggestionsEnc: text("suggestions_enc"),
    failureReason: text("failure_reason").$type<ResumeImportFailureName>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One row per stored object. A retried confirm is then detectable rather than a second row
    // claiming the same bytes.
    uniqueIndex("wri_storage_key_uq").on(t.storageKey),
    // The only read this table has: "this worker's imports, newest first".
    index("wri_worker_recent_idx").on(t.workerId, t.createdAt.desc()),
    check(
      "wri_status_chk",
      sql`${t.status} IN ('uploaded', 'parsing', 'parsed', 'failed', 'discarded')`,
    ),
    check(
      "wri_extraction_method_chk",
      sql`${t.extractionMethod} IS NULL OR ${t.extractionMethod} IN ('pdf_text', 'docx', 'ocr')`,
    ),
    check("wri_route_chk", sql`${t.route} IS NULL OR ${t.route} IN ('form', 'chat')`),
    check("wri_byte_size_chk", sql`${t.byteSize} > 0`),
    check("wri_storage_key_present_chk", sql`length(btrim(${t.storageKey})) > 0`),
    check("wri_page_count_chk", sql`${t.pageCount} IS NULL OR ${t.pageCount} > 0`),
    // A confidence only means something for OCR. Tying it to the method stops a `pdf_text` row
    // growing a score that nothing computed and that a later reader would average anyway.
    check(
      "wri_ocr_confidence_chk",
      sql`(${t.ocrConfidence} IS NULL AND ${t.extractionMethod} IS DISTINCT FROM 'ocr') OR (${t.extractionMethod} = 'ocr' AND ${t.ocrConfidence} BETWEEN 0 AND 1)`,
    ),
    // `form_kind` is meaningful ONLY on the form route, and is REQUIRED there: a row saying
    // "we sent him to a form" without naming which one describes a handover nobody can
    // reproduce. A BICONDITIONAL, so neither half can drift.
    check("wri_form_kind_chk", sql`(${t.route} = 'form') = (${t.formKind} IS NOT NULL)`),
    // A failure reason belongs to a failure, and a failure must carry one. Same argument.
    check(
      "wri_failure_reason_chk",
      sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`,
    ),
    // Suggestions exist only once a parse succeeded. Without this a `failed` row could carry a
    // payload the worker would then be offered — the parse's own rejection, shown as advice.
    check("wri_suggestions_chk", sql`${t.suggestionsEnc} IS NULL OR ${t.status} = 'parsed'`),
  ],
).enableRLS(); // FORCE + REVOKE carried by the migration, like every other worker table
