import { z } from "zod";

import { looksLikePii } from "@badabhai/validators";

/**
 * The worker's PORTFOLIO page — work samples (ADR-0042 D9 / Layer A (e), migration 0113).
 *
 * PUT replaces the whole list, the qualifications seam: repeatable, ordered rows under
 * `(worker_id, sort_order)`. Three item kinds, and the schema keeps each kind's payload honest:
 *
 *   photo / video  → `storage_key`, MINTED BY THIS SERVER for this worker (the client may only
 *                    return a key it was given; the service re-verifies the prefix).
 *   link           → `url`, http(s) only.
 *
 * CAPTIONS ARE FREE TEXT AND SCREENED with `looksLikePii` — this is a worker-typed string that
 * may one day print, and a phone number in a caption is the same walk-in hazard the certificate
 * fields already screen for.
 */

export const PORTFOLIO_ITEMS_MAX = 12;
const CAPTION_MAX = 160;
const URL_MAX = 512;

/** http(s) only. A `javascript:` or protocol-relative URL is not a portfolio link. */
const linkUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(URL_MAX)
  .regex(/^https?:\/\/\S+$/, "url must be an http(s) link");

/**
 * THE MINTED-KEY SHAPE for THIS worker, re-checked here as well as in the service.
 *
 * `portfolio/{workerId}/{uuid}.{ext}` — the same anti-forgery posture the photo confirm route
 * takes: a client can only register back a key the server chose for it.
 *
 * BUILT WITHOUT A DYNAMIC RegExp. Interpolating the worker id into a pattern is a regex-injection
 * shape (and semgrep refuses it on sight); none of this needs a pattern — a prefix check, one
 * literal shape check and a closed extension set express the same rule exactly.
 */
const UUID_SHAPE = /^[0-9a-f-]{36}$/;
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "mov"]);

export function portfolioKeyBelongsTo(workerId: string, key: string): boolean {
  const prefix = `portfolio/${workerId}/`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return false;
  return UUID_SHAPE.test(rest.slice(0, dot)) && ALLOWED_EXTENSIONS.has(rest.slice(dot + 1));
}

export const SetMyPortfolioSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            kind: z.enum(["photo", "video", "link"]),
            /** Required for photo/video; must be a key this server minted for this worker. */
            storage_key: z.string().trim().min(1).max(512).optional(),
            url: linkUrlSchema.optional(),
            caption: z
              .string()
              .trim()
              .max(CAPTION_MAX)
              .refine((value) => !looksLikePiiLoose(value), {
                message: "remove contact details from the caption",
              })
              .nullable()
              .optional(),
          })
          .strict()
          .refine(
            (item) =>
              item.kind === "link"
                ? item.url !== undefined && item.storage_key === undefined
                : item.storage_key !== undefined && item.url === undefined,
            { message: "a photo/video carries a storage_key; a link carries a url" },
          ),
      )
      .max(PORTFOLIO_ITEMS_MAX),
  })
  .strict();

export type SetMyPortfolioDto = z.infer<typeof SetMyPortfolioSchema>;
export type PortfolioItemDto = SetMyPortfolioDto["items"][number];

/** The mint request: what kind of media, and its declared content type. */
export const PortfolioUploadUrlSchema = z
  .object({
    kind: z.enum(["photo", "video"]),
    content_type: z.string().trim().min(1).max(120),
  })
  .strict();
export type PortfolioUploadUrlDto = z.infer<typeof PortfolioUploadUrlSchema>;

export interface MyPortfolioItemView {
  readonly kind: "photo" | "video" | "link";
  /** A short-lived signed URL for media (bucket armed), the raw URL for a link. */
  readonly url: string | null;
  readonly caption: string | null;
}

export interface MyPortfolioResponse {
  readonly items: readonly MyPortfolioItemView[];
}

/** The caption screen: a blank caption is absence, not PII. */
function looksLikePiiLoose(value: string): boolean {
  return value.trim() !== "" && looksLikePii(value);
}
