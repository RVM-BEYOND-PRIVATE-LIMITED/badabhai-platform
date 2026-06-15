import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Resume PDF storage — signed-URL SECURITY proof against a LIVE Supabase Storage
 * (TD24 / R13). The three properties that can ONLY be proven against a running
 * Storage API (the unit tests in apps/api cover the controller wiring + no-PII):
 *
 *   1. HAPPY PATH   — upload to the private bucket, mint a short-TTL signed URL,
 *                     GET it → 200 + application/pdf.
 *   2. ANON DENIED  — the PUBLIC object route AND the raw authenticated object route
 *                     WITHOUT a token both fail (a private bucket has no anon read).
 *   3. EXPIRY       — a 1s signed URL stops serving after it expires (non-200).
 *
 * Plus a bucket-is-PRIVATE assertion (the bucket metadata reports public=false).
 *
 * SAFETY: this NEVER touches shared infra on its own. It is OPT-IN — it runs only
 * when RESUME_STORAGE_E2E=1 AND staging Supabase creds are present; otherwise it
 * SKIPS (so CI and local without creds stay green). It writes only under a clearly
 * test-scoped key prefix (`resumes/_e2e/...`) and deletes the object in afterAll.
 * Point it at STAGING, never production.
 *
 * Run (staging creds in the shell — service-role key is a god-key, backend only):
 *   RESUME_STORAGE_E2E=1 \
 *   SUPABASE_URL=https://<staging-ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<staging service-role key> \
 *   RESUMES_BUCKET=worker-resumes \
 *   pnpm --filter @badabhai/e2e test -- resume-signed-url
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.RESUMES_BUCKET ?? "worker-resumes";
const RUN = process.env.RESUME_STORAGE_E2E === "1" && SUPABASE_URL !== "" && SERVICE_KEY !== "";

// A clearly test-scoped object key (opaque, no PII — same shape as the real worker).
const KEY = `resumes/_e2e/${crypto.randomUUID()}/${crypto.randomUUID()}/v1.pdf`;
// Minimal well-formed-enough PDF payload; Storage just stores/serves the bytes.
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% e2e signed-url proof\n%%EOF\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const objectUrl = (route: string) => `${SUPABASE_URL}/storage/v1/object/${route}`;

async function uploadPdf(): Promise<void> {
  const res = await fetch(objectUrl(`${BUCKET}/${encodeURI(KEY)}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/pdf",
      "x-upsert": "true",
    },
    body: PDF_BYTES,
  });
  if (!res.ok) throw new Error(`setup upload failed: ${res.status}`);
}

async function signUrl(ttlSeconds: number): Promise<string> {
  const res = await fetch(objectUrl(`sign/${BUCKET}/${encodeURI(KEY)}`), {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);
  const body = (await res.json()) as { signedURL?: string };
  if (!body.signedURL) throw new Error("sign response missing signedURL");
  return `${SUPABASE_URL}/storage/v1${body.signedURL}`;
}

describe.skipIf(!RUN)("Resume signed-URL storage security (TD24 / R13)", () => {
  beforeAll(async () => {
    await uploadPdf();
  });

  afterAll(async () => {
    // Best-effort cleanup; don't fail the suite on a cleanup hiccup.
    await fetch(objectUrl(`${BUCKET}/${encodeURI(KEY)}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${SERVICE_KEY}` },
    }).catch(() => undefined);
  });

  it("the bucket is PRIVATE (public=false) — no anon read path by construction", async () => {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, {
      headers: { authorization: `Bearer ${SERVICE_KEY}` },
    });
    expect(res.ok).toBe(true);
    const bucket = (await res.json()) as { public?: boolean };
    expect(bucket.public).toBe(false);
  });

  it("HAPPY PATH: a short-TTL signed URL serves the PDF (200, application/pdf)", async () => {
    const url = await signUrl(60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });

  it("ANON DENIED: the PUBLIC object route does NOT serve a private-bucket object", async () => {
    const res = await fetch(objectUrl(`public/${BUCKET}/${encodeURI(KEY)}`));
    expect(res.status).not.toBe(200); // private bucket → 400/403
  });

  it("ANON DENIED: the raw object route WITHOUT a token is rejected", async () => {
    const res = await fetch(objectUrl(`${BUCKET}/${encodeURI(KEY)}`)); // no Authorization header
    expect(res.status).not.toBe(200); // 400/401/403
  });

  it("EXPIRY: a 1s signed URL stops serving after it expires", async () => {
    const url = await signUrl(1);
    // It should work right now...
    const fresh = await fetch(url);
    expect(fresh.status).toBe(200);
    // ...and fail once the token's exp passes.
    await sleep(3000);
    const expired = await fetch(url);
    expect(expired.status).not.toBe(200); // jwt expired → 400/403
  });
});
