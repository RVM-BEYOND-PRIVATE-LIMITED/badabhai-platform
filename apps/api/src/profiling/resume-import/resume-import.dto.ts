import { z } from "zod";
import { RESUME_UPLOAD_MIME_TYPES, type ResumeUploadMimeName } from "@badabhai/types";

/**
 * The résumé-import wire shapes (ADR-0041, phase RI-1).
 *
 * THE CLIENT CHOOSES ALMOST NOTHING, and that is the design rather than an accident. It names
 * the KIND of document it is about to upload, and that is the whole of its influence: the object
 * key, the bucket, the TTL and the eventual filename are all server-chosen. Every field a client
 * could have supplied here is a field an attacker could have supplied.
 */

/**
 * Why the declared mime is asked for at all, when the object is measured later anyway.
 *
 * IT PICKS THE EXTENSION, AND NOTHING ELSE. The key has to end in something, and a server that
 * guessed would have to either accept a client-supplied suffix (free text in an object key —
 * the exact hole `feedback.service.ts` closes with its full-shape regex) or mint every résumé as
 * `.bin` and lose the one cheap signal that tells an operator what is in the bucket.
 *
 * IT IS A DECLARATION, NEVER A TRUST. The signed URL cannot constrain what the client actually
 * PUTs, so the confirm step reads the mime back from Storage object-info and checks THAT — both
 * that it is in the allowlist and that it matches what was declared here. A client that declares
 * a PDF and uploads a JPEG is refused at confirm, and the object is deleted rather than left
 * behind.
 */
const RESUME_MIME_TO_EXTENSION: Readonly<Record<ResumeUploadMimeName, string>> = Object.freeze({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg",
  "image/png": "png",
});

/**
 * The closed extension set, derived from the map above rather than written out again.
 *
 * The confirm route's ownership regex is built from this, so a fifth document type added to
 * `RESUME_UPLOAD_MIME_TYPES` widens the mint and the regex together. Two hand-written lists
 * would drift, and the drift that matters is silent: a regex that no longer matches the keys the
 * mint produces refuses every honest confirm, and one that matches MORE than the mint produces
 * is the ownership check quietly weakening.
 */
export const RESUME_UPLOAD_EXTENSIONS: readonly string[] = Object.freeze(
  Object.values(RESUME_MIME_TO_EXTENSION),
);

export function extensionForResumeMime(mime: ResumeUploadMimeName): string {
  return RESUME_MIME_TO_EXTENSION[mime];
}

/**
 * `POST /profiling/resume-import/upload-url`.
 *
 * `.strict()`, so an unknown field is a 400 rather than something silently ignored. The voice
 * and photo mints take an EMPTY body for the same reason this one is nearly empty: the client
 * chooses nothing about the destination.
 */
export const CreateResumeUploadUrlSchema = z
  .object({
    /** What the worker is about to upload. Declaration only — see the map above. */
    mime: z.enum(RESUME_UPLOAD_MIME_TYPES),
  })
  .strict();
export type CreateResumeUploadUrlDto = z.infer<typeof CreateResumeUploadUrlSchema>;

/**
 * `POST /profiling/resume-import` — register the object that was just PUT.
 *
 * ONLY THE KEY, and it is checked against a shape the server minted for THIS worker rather than
 * trusted. There is deliberately no `mime` and no `byte_size` here: both are read back from
 * Storage object-info, because a client that can state its own size is a client that can defeat
 * the size cap by lying about it.
 */
export const ConfirmResumeImportSchema = z
  .object({
    /** The `storage_path` handed back by the mint, unchanged. */
    storage_path: z.string().min(1).max(200),
  })
  .strict();
export type ConfirmResumeImportDto = z.infer<typeof ConfirmResumeImportSchema>;

/** `GET /profiling/resume-import/:importId`. */
export const ResumeImportIdParamSchema = z.object({
  importId: z.string().uuid(),
});
export type ResumeImportIdParamDto = z.infer<typeof ResumeImportIdParamSchema>;
