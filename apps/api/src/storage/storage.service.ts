import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * Supabase Storage client over the REST API + `fetch` (NO SDK — Storage Mode A,
 * same as the conversations artifact path). Uses the service-role key, so it is
 * backend-only and bypasses RLS by design.
 *
 * SECURITY: the `RESUMES_BUCKET` MUST be created PRIVATE (anon denied) OUT-OF-BAND
 * by devops. RLS and migration 0009 cover Postgres TABLES only — they do NOT
 * govern Storage object ACLs. A public bucket would expose every rendered PDF
 * (which contains the worker's real name) to anyone who guesses the object key.
 * Object keys carry only opaque UUIDs (worker_id/resume_id); no PII in the path.
 */
@Injectable()
export class StorageService {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  /**
   * Upload PDF bytes to `${RESUMES_BUCKET}/${objectKey}` (upsert). Throws a
   * PII-free error on a non-2xx response or transport failure so the calling
   * processor can record a render failure / retry.
   */
  async uploadPdf(objectKey: string, bytes: Buffer): Promise<void> {
    const { url, serviceKey, bucket } = this.requireStorage();
    const target = `${url}/storage/v1/object/${bucket}/${encodeURI(objectKey)}`;
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
   * Mint a short-lived signed URL for `${RESUMES_BUCKET}/${objectKey}`. Returns an
   * ABSOLUTE url. Throws a PII-free error on failure.
   */
  async createSignedUrl(objectKey: string, ttlSeconds: number): Promise<string> {
    const { url, serviceKey, bucket } = this.requireStorage();
    const target = `${url}/storage/v1/object/sign/${bucket}/${encodeURI(objectKey)}`;
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

  /** Guard: Storage requires both SUPABASE_URL and the service-role key. */
  private requireStorage(): { url: string; serviceKey: string; bucket: string } {
    const url = this.config.SUPABASE_URL;
    const serviceKey = this.config.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error("Supabase Storage is not configured (SUPABASE_URL / SERVICE_ROLE_KEY)");
    }
    return { url, serviceKey, bucket: this.config.RESUMES_BUCKET };
  }
}
