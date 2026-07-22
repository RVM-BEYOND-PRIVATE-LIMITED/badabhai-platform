import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * Supabase Storage client over the REST API + `fetch` (NO SDK — Storage Mode A,
 * same as the conversations artifact path). Uses the service-role key, so it is
 * backend-only and bypasses RLS by design.
 *
 * SECURITY: every bucket this touches (`RESUMES_BUCKET`, `INTERVIEW_KIT_BUCKET`,
 * `WORKER_PHOTOS_BUCKET`) MUST be created PRIVATE (anon denied) OUT-OF-BAND by
 * devops. RLS and migration 0009 cover Postgres TABLES only — they do NOT govern
 * Storage object ACLs. A public bucket would expose every rendered PDF / worker
 * photo to anyone who guesses the object key. Object keys carry only opaque UUIDs
 * (resume, photos) or trade slugs + a version (interview kits) — never PII.
 *
 * Each method takes an optional `bucket` (defaults to `RESUMES_BUCKET` for the
 * existing resume callers); the interview-kit feature passes `INTERVIEW_KIT_BUCKET`.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  /**
   * Upload PDF bytes to `${bucket}/${objectKey}` (upsert). Throws a PII-free error
   * on a non-2xx response or transport failure so the caller can record a render
   * failure / retry.
   */
  async uploadPdf(objectKey: string, bytes: Buffer, bucket?: string): Promise<void> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    const target = `${url}/storage/v1/object/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/pdf",
          "x-upsert": "true",
        },
        body: new Uint8Array(bytes),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Never include the bytes or any decrypted name in the error message.
        throw new Error(`storage upload failed with status ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * True if `${bucket}/${objectKey}` already exists. Used by the interview-kit
   * render-once path: a present object means "serve the cached kit, don't re-render".
   * A 404 is "absent" (false); any OTHER failure THROWS so the caller can decide
   * (it must NOT silently treat a transport error as "absent" and re-render forever).
   */
  async objectExists(objectKey: string, bucket?: string): Promise<boolean> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    // The `info` endpoint returns object metadata (200) or 404 — no bytes transferred.
    const target = `${url}/storage/v1/object/info/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(target, {
        method: "GET",
        headers: { authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
      });
      if (res.ok) return true;
      // Supabase's object/info returns HTTP 400 with body {error:"not_found"} — NOT a
      // plain 404 — when the object is absent on current builds; older builds return
      // 404. Both mean "absent" (render-once: re-render + store). A real 400 without
      // that body still THROWS (a transport/config error must not read as "absent").
      if (StorageService.isNotFound(res.status, await StorageService.safeText(res))) return false;
      throw new Error(`storage object-info failed with status ${res.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Object metadata for `${bucket}/${objectKey}` — or null when absent (404).
   * ADR-0032: the photo-confirm route validates the UPLOADED OBJECT (content type +
   * size cap) against this before persisting the pointer, since the signed upload
   * URL itself cannot constrain what the client PUTs. Any non-404 failure THROWS
   * (a transport error must not read as "absent"). PII-free errors only.
   */
  async getObjectInfo(
    objectKey: string,
    bucket?: string,
  ): Promise<{ contentType: string | null; sizeBytes: number | null } | null> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    const target = `${url}/storage/v1/object/info/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(target, {
        method: "GET",
        headers: { authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Absent object → null (see isNotFound: 404, or the current-build 400+not_found).
        const bodyText = await StorageService.safeText(res);
        if (StorageService.isNotFound(res.status, bodyText)) return null;
        throw this.storageFailure("storage object-info", res.status, b, bodyText);
      }
      // The info endpoint's field names have varied across Supabase versions: the
      // CURRENT build returns snake_case `content_type` + a top-level `size`; older
      // builds used `contentType` / `metadata.mimetype` / `metadata.size`. Read ALL
      // shapes so the photo-confirm mime/size gate (ADR-0032) never false-rejects a
      // valid upload as null → 400.
      const body = (await res.json()) as {
        content_type?: string;
        contentType?: string;
        size?: number;
        metadata?: { mimetype?: string; size?: number };
      };
      const contentType = body.content_type ?? body.contentType ?? body.metadata?.mimetype ?? null;
      const size = body.size ?? body.metadata?.size;
      return {
        contentType,
        sizeBytes: typeof size === "number" && Number.isFinite(size) ? size : null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Download the raw bytes of `${bucket}/${objectKey}` — or null when absent (404).
   * ADR-0032: the resume-render processor fetches the worker's photo to embed it as
   * a data: URI in the worker's OWN PDF (WeasyPrint renders from stdin with no
   * network, so a signed URL cannot be fetched at render time). Callers must treat
   * the bytes as PII: never log them, never let them reach events/ai_jobs. Any
   * non-404 failure THROWS a PII-free error (callers degrade, they don't guess).
   */
  async downloadObject(objectKey: string, bucket?: string): Promise<Buffer | null> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    const target = `${url}/storage/v1/object/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(target, {
        method: "GET",
        headers: { authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Absent photo → null (worker has none yet); the caller degrades (renders
        // without a photo). Any OTHER failure THROWS so it is not read as "absent".
        if (StorageService.isNotFound(res.status, await StorageService.safeText(res))) return null;
        throw new Error(`storage download failed with status ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Delete a single object `${bucket}/${objectKey}` (ADR-0026 Phase 5 — DPDP erasure).
   * A 404 is treated as ALREADY-GONE (success — deletion is idempotent). Any OTHER non-2xx
   * or transport failure THROWS a PII-free error so the caller can count it as a failed
   * object delete and continue (an orphan keyed by an opaque UUID is non-PII-linkable and
   * re-runnable — it must NOT abort the whole account erasure). Mirrors uploadPdf's structure
   * (AbortController timeout, never any bytes/decrypted-name/path-PII in an error message).
   */
  async deletePdf(objectKey: string, bucket?: string): Promise<void> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    const target = `${url}/storage/v1/object/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(target, {
        method: "DELETE",
        headers: { authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
      });
      // 404 = already gone → idempotent success. Object keys are opaque UUIDs, so the
      // status carries no PII.
      if (res.status === 404) return;
      if (!res.ok) {
        throw new Error(`storage delete failed with status ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Delete EVERY object under `prefix` in `${bucket}` (ADR-0026 Phase 5 / ADR-0032 —
   * DPDP erasure of a worker's archived conversations / profile photos, keyed
   * `<worker_id>/...`). PAGES the listing until it is drained (the list endpoint caps a
   * page at 1000 — a single-page sweep would silently strand residual PII objects past
   * the first 1000 and report success; bb-security-review M-1). Returns the count of
   * objects deleted (0 when the prefix is empty/absent — never an error for "nothing to
   * delete"). PII-free errors only: object keys are opaque UUIDs, and no bytes/
   * decrypted-name ever appears in a message.
   */
  async deleteByPrefix(prefix: string, bucket?: string): Promise<number> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);

    let total = 0;
    // Safety valve, not a coverage cap: 100 pages = 100k objects, far above any real
    // worker's set. Prevents an infinite loop if the store keeps returning a page.
    for (let page = 0; page < 100; page += 1) {
      const keys = await this.listUnderPrefix(url, serviceKey, b, prefix);
      if (keys.length === 0) return total;

      const target = `${url}/storage/v1/object/${b}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(target, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${serviceKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prefixes: keys }),
          signal: controller.signal,
        });
        // A 404 here means the bucket/keys vanished between list + delete → treat as gone.
        if (res.status === 404) return total;
        if (!res.ok) {
          throw new Error(`storage batch-delete failed with status ${res.status}`);
        }
        total += keys.length;
      } finally {
        clearTimeout(timeout);
      }
      // A short page means the prefix is drained — no need for a confirming empty list.
      if (keys.length < 1000) return total;
    }
    return total;
  }

  /**
   * List object keys under `prefix` in `bucket` via the Storage `list` endpoint. Returns
   * FULLY-QUALIFIED keys (`<prefix><name>`), since the API returns names relative to the
   * prefix. Empty/absent prefix → []. PII-free errors only (opaque keys).
   */
  private async listUnderPrefix(
    url: string,
    serviceKey: string,
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const target = `${url}/storage/v1/object/list/${bucket}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
        },
        // `limit` is the Supabase max page size. A worker's archived-conversation set is
        // small (one snapshot object per session); a single page is sufficient for Phase 5.
        body: JSON.stringify({ prefix, limit: 1000 }),
        signal: controller.signal,
      });
      if (res.status === 404) return [];
      if (!res.ok) {
        throw new Error(`storage list failed with status ${res.status}`);
      }
      const body = (await res.json()) as Array<{ name?: string; id?: string | null }>;
      // The list endpoint returns names RELATIVE to the prefix; folder placeholders have a
      // null id. Keep only real objects and re-qualify with the prefix for deletion.
      return body
        .filter((o): o is { name: string; id?: string | null } => typeof o.name === "string" && o.name.length > 0)
        .map((o) => `${prefix}${o.name}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Mint a short-lived signed URL for `${bucket}/${objectKey}`. Returns an
   * ABSOLUTE url. Throws a PII-free error on failure.
   */
  async createSignedUrl(objectKey: string, ttlSeconds: number, bucket?: string): Promise<string> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    const target = `${url}/storage/v1/object/sign/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`storage sign-url failed with status ${res.status}`);
      }
      const body = (await res.json()) as { signedURL?: string };
      if (!body.signedURL) {
        throw new Error("storage sign-url response missing signedURL");
      }
      // signedURL is a relative path under /storage/v1; return the absolute url.
      return `${url}/storage/v1${body.signedURL}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Mint a signed UPLOAD URL for `${bucket}/${objectKey}` (the voice-note client
   * PUTs the audio bytes to it directly — the API never proxies audio). Returns
   * an ABSOLUTE url + its lifetime. Throws a PII-free error on failure. The URL
   * embeds a bearer token: callers must NEVER log or emit it (same rule as
   * createSignedUrl).
   */
  async createSignedUploadUrl(
    objectKey: string,
    bucket?: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const { url, serviceKey, bucket: b } = this.requireStorage(bucket);
    const target = `${url}/storage/v1/object/upload/sign/${b}/${encodeURI(objectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw this.storageFailure(
          "storage sign-upload-url",
          res.status,
          b,
          await StorageService.safeText(res),
        );
      }
      // Supabase has returned this as `url` (REST) and `signedURL` (older SDKs);
      // accept either defensively.
      const body = (await res.json()) as { url?: string; signedURL?: string };
      const relative = body.url ?? body.signedURL;
      if (!relative) {
        throw new Error("storage sign-upload-url response missing url");
      }
      // The upload-sign token lifetime is FIXED server-side by Supabase (~2h) and
      // not configurable per request, so we surface a conservative constant
      // rather than a config knob that could not actually change anything.
      return { url: `${url}/storage/v1${relative}`, expiresIn: 7200 };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * True when a Storage response means "object absent". Supabase's `object/info`
   * endpoint on the current build answers a MISSING object with HTTP 400 and body
   * `{"statusCode":"404","error":"not_found","message":"Object not found"}` — NOT a
   * plain 404 — so a status-only `=== 404` check misses it (that regression surfaced
   * as interview-kit 503s and photo-confirm 400s: `objectExists`/`getObjectInfo`
   * threw / returned null on every absent object). Older builds and the raw download
   * endpoint use a plain 404. A real 400 (bad request) WITHOUT a not-found body is
   * NOT absent — it still throws upstream.
   */
  private static isNotFound(status: number, bodyText: string): boolean {
    if (status === 404) return true;
    if (status !== 400 || !bodyText) return false;
    try {
      const b = JSON.parse(bodyText) as { statusCode?: string | number; error?: string; message?: string };
      return (
        b?.error === "not_found" ||
        String(b?.statusCode) === "404" ||
        /not\s*found/i.test(b?.message ?? "")
      );
    } catch {
      return false;
    }
  }

  /** Best-effort body read for error classification — never throws, never logged. */
  private static async safeText(res: { text?: () => Promise<string> }): Promise<string> {
    try {
      return typeof res.text === "function" ? await res.text() : "";
    } catch {
      return "";
    }
  }

  /**
   * Guard: Storage requires both SUPABASE_URL and the service-role key. `bucket`
   * defaults to RESUMES_BUCKET (the existing resume callers); pass another bucket
   * (e.g. INTERVIEW_KIT_BUCKET) explicitly.
   */
  private requireStorage(bucket?: string): { url: string; serviceKey: string; bucket: string } {
    const url = this.config.SUPABASE_URL;
    const serviceKey = this.config.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      // 503, NOT a bare Error. Both keys are `.optional()` in the server config and
      // NOTHING fails boot without them — the only Supabase boot guard covers
      // PAYER_LOGIN_METHOD="supabase", not Storage. So an API can run perfectly
      // happily and then throw here on the FIRST upload. As a bare Error that
      // surfaced to the worker as an opaque HTTP 500 ("something broke"), which is
      // both wrong (nothing broke — the server was never configured) and
      // undiagnosable. Naming the missing keys is safe: these are VARIABLE NAMES,
      // never values (§2 — no secrets in logs or responses).
      const missing = [!url && "SUPABASE_URL", !serviceKey && "SUPABASE_SERVICE_ROLE_KEY"]
        .filter(Boolean)
        .join(", ");
      this.logger.error(
        `Supabase Storage is not configured; missing: ${missing}. ` +
          `Every upload/download will fail until these are set.`,
      );
      throw new ServiceUnavailableException(
        `Supabase Storage is not configured (missing: ${missing})`,
      );
    }
    // `??` deliberately, NOT `||`: an explicitly-passed bucket is honoured even if
    // some future caller passes one that is falsy-but-present. An EMPTY string,
    // however, must never reach the URL builder — it would produce
    // `/object/upload/sign//photos/...` and come back as an opaque upstream 400.
    // Callers whose bucket is optional (photos, voice notes) already 503 on empty
    // before they get here; this is the backstop for the ones that do not.
    const resolved = bucket ?? this.config.RESUMES_BUCKET;
    if (!resolved) {
      this.logger.error(
        "Supabase Storage called with an empty bucket name — the feature's *_BUCKET env var is unset.",
      );
      throw new ServiceUnavailableException("storage bucket is not configured");
    }
    return { url, serviceKey, bucket: resolved };
  }

  /**
   * Turn a non-2xx Storage response into an error whose CAUSE is readable.
   *
   * WHY THIS EXISTS. Every failure path here used to throw a bare
   * `Error(\`storage X failed with status \${res.status}\`)`, which Nest maps to a
   * blanket **HTTP 500**. The two failures that actually happen in practice are
   * both CONFIGURATION, not crashes:
   *   1. the bucket named by the env var does not exist in this Supabase project
   *      (buckets are created OUT-OF-BAND — see the class doc), and
   *   2. the service-role key is wrong / from another project (401/403).
   * Both surfaced to the worker as an identical, causeless 500 — the exact
   * "generic error" this project forbids. A missing bucket is now a 503 that SAYS
   * the bucket is missing and NAMES it, so the same message that reaches the log
   * also tells devops what to create.
   *
   * PII/secret-safety: bucket names and HTTP statuses only — never the key, never
   * the object key (which is opaque anyway), never a response body that could echo
   * a signed URL.
   */
  private storageFailure(operation: string, status: number, bucket: string, bodyText: string): Error {
    // A missing bucket is reported by Supabase in THREE different shapes depending on
    // endpoint and build, and only one of them says the word "bucket":
    //   * a plain 404,
    //   * a 400 with {"statusCode":"404","error":"not_found", ...} (the object/info shape),
    //   * a BARE 400 with an empty/unhelpful body — which is what
    //     `object/upload/sign/<bucket>/<key>` returns for a bucket that does not exist.
    // The third shape was measured in production: WORKER_PHOTOS_BUCKET was set to a name
    // with no matching bucket, sign-upload-url answered 400 with nothing to match on, and
    // the worker got an opaque HTTP 500 on every photo upload.
    //
    // So: any 400/404 on a SIGN or INFO operation is treated as "bucket problem". The
    // object key cannot cause it — the server mints that key itself (an opaque UUID under
    // the worker's own prefix, ADR-0032), so there is no client-controlled input left to
    // blame. Naming the bucket in the message is what turns a 20-minute log hunt into a
    // one-line env fix; bucket names are config, never PII.
    const bucketShaped =
      StorageService.isNotFound(status, bodyText) ||
      /bucket/i.test(bodyText) ||
      status === 400 ||
      status === 404;
    if (bucketShaped) {
      this.logger.error(
        `${operation}: bucket "${bucket}" does not exist in this Supabase project (status ${status}). ` +
          `Storage buckets are created out-of-band and MUST be PRIVATE. Check the *_BUCKET env ` +
          `var matches the bucket name EXACTLY (this repo's buckets use hyphens, not underscores).`,
      );
      return new ServiceUnavailableException(
        `storage bucket "${bucket}" does not exist — create it (private) in Supabase, ` +
          `or fix the bucket name in the environment`,
      );
    }
    if (status === 401 || status === 403) {
      this.logger.error(
        `${operation}: Supabase rejected the service-role key (status ${status}) for bucket "${bucket}". ` +
          `The key is missing, wrong, or belongs to a different project.`,
      );
      return new ServiceUnavailableException("storage credentials rejected by Supabase");
    }
    this.logger.error(`${operation} failed with status ${status} for bucket "${bucket}"`);
    return new Error(`${operation} failed with status ${status}`);
  }
}
