import { Inject, Injectable } from "@nestjs/common";
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
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`storage object-info failed with status ${res.status}`);
      return true;
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
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage object-info failed with status ${res.status}`);
      // The info endpoint returns metadata; field names have varied across Supabase
      // versions (contentType vs metadata.mimetype, size vs metadata.size) — read both.
      const body = (await res.json()) as {
        contentType?: string;
        size?: number;
        metadata?: { mimetype?: string; size?: number };
      };
      const contentType = body.contentType ?? body.metadata?.mimetype ?? null;
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
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage download failed with status ${res.status}`);
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
        throw new Error(`storage sign-upload-url failed with status ${res.status}`);
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
   * Guard: Storage requires both SUPABASE_URL and the service-role key. `bucket`
   * defaults to RESUMES_BUCKET (the existing resume callers); pass another bucket
   * (e.g. INTERVIEW_KIT_BUCKET) explicitly.
   */
  private requireStorage(bucket?: string): { url: string; serviceKey: string; bucket: string } {
    const url = this.config.SUPABASE_URL;
    const serviceKey = this.config.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error("Supabase Storage is not configured (SUPABASE_URL / SERVICE_ROLE_KEY)");
    }
    return { url, serviceKey, bucket: bucket ?? this.config.RESUMES_BUCKET };
  }
}
