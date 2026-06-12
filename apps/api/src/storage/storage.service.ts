import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * Supabase Storage client over the REST API + `fetch` (NO SDK — Storage Mode A,
 * same as the conversations artifact path). Uses the service-role key, so it is
 * backend-only and bypasses RLS by design.
 *
 * SECURITY: every bucket this touches (`RESUMES_BUCKET`, `INTERVIEW_KIT_BUCKET`)
 * MUST be created PRIVATE (anon denied) OUT-OF-BAND by devops. RLS and migration
 * 0009 cover Postgres TABLES only — they do NOT govern Storage object ACLs. A
 * public bucket would expose every rendered PDF to anyone who guesses the object
 * key. Object keys carry only opaque UUIDs (resume) or trade slugs + a version
 * (interview kits) — never PII.
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
