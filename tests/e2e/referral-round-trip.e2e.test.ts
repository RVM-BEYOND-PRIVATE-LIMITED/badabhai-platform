import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDbClient, events, referralClicks, type DbClient } from "@badabhai/db";

/**
 * THE REFERRAL ROUND-TRIP — share → click → install → first-touch attribution.
 *
 * This is the leg the funnel never had end-to-end. Each stage was unit tested in
 * isolation, but nothing exercised the JOIN between them, and the join is where the
 * interesting failures live: `GET /r/:code` writes `referral_clicks`, and
 * `POST /referrals/attribute` reconciles a worker against it through a code that is
 * deliberately NOT carried on any event. A per-layer mock cannot catch a mismatch between
 * those two spaces — only a real code travelling through real HTTP against a real DB can.
 *
 * WHAT IT PROVES
 *  1. `GET /r/:code` — no session, Android user-agent — 302s to the App Link and logs
 *     EXACTLY ONE `referral_clicks` row.
 *  2. `POST /referrals/attribute` (worker-authed, post-consent) claims that click.
 *  3. FIRST TOUCH IS IDEMPOTENT: re-posting claims nothing new. That is the partial unique
 *     index on `claimed_by_worker_id` holding under a real second request, not a unit
 *     test's stubbed conflict.
 *  4. A worker who has NOT consented attributes nothing (invariant #6, over HTTP).
 *  5. THE BEARER CODE NEVER REACHES THE SPINE — asserted against every event row the whole
 *     loop produced, not just the ones we expected to look at.
 *
 * ── WHY THE AGENT-MINT LEG IS NOT HERE ──────────────────────────────────────
 * The natural first step would be `POST /payer/agency/invites` (which is where the W1 link
 * metadata lands). It CANNOT run in CI: minting an agent session needs a payer login, the
 * `dev_otp` echo is gone, and there is no payer equivalent of `/auth/test-login` — the same
 * wall that has `payer-tenancy.e2e.test.ts` sitting at `describe.skip`. Rather than add a
 * second permanently-skipped suite, this one seeds a synthetic code and starts at the
 * click. The resolver treats an unknown code exactly as it treats a legacy `agency_invites`
 * code (`referral_link_id IS NULL`, organic window) — which is the real production path for
 * every code minted before B4 — so this is the honest shape, not a weakened one.
 *
 * The mint half is covered by unit tests (`agency-invites-batch.test.ts`,
 * `agency.dto.test.ts`) and, for migration 0068 itself, by applying it to a live Postgres.
 * A payer test-login seam would let this suite start one step earlier; that is the open
 * §7 decision, not something to fake here.
 *
 * Opt-in (requires a running API + Postgres + Redis):
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate
 *   3. pnpm --filter @badabhai/api start   (with TEST_LOGIN_ENABLED/TEST_LOGIN_TOKEN set)
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 */

const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const CONSENT_VERSION = "2026-06-01";

// Needs BOTH the e2e opt-in and the gated worker-mint seam. Without the token there is no
// way to authenticate a worker at all (the OTP journeys are real-provider-only), so the
// suite would fail rather than test anything — skip honestly instead.
const RUN = process.env.RUN_E2E === "1" && TEST_LOGIN_TOKEN.length > 0;

// A real Android UA. `platformFromUserAgent` must classify this as 'android' so the
// resolver takes the App-Link leg; a UA that reads as a bot logs NO click at all
// (`isLikelyBot`), which would make this whole suite silently vacuous.
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/** A fresh, well-formed referral code (12 lowercase hex — `isWellFormedReferralCode`). */
const freshCode = (): string => randomUUID().replace(/-/g, "").slice(0, 12);

/**
 * A phone inside the RESERVED SYNTHETIC range the test-login mint serves
 * (`+91` + five zeros + five free digits). Randomised so each test owns a distinct worker
 * — the mint find-or-creates by phone hash, and a reused worker could arrive already
 * holding a claim, which would quietly invalidate the "exactly one" assertions.
 */
const syntheticPhone = (): string =>
  `+9100000${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;

async function req(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    token?: string;
    ua?: string;
    testLogin?: boolean;
    manualRedirect?: boolean;
  } = {},
): Promise<{ status: number; json: any; location: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.ua) headers["user-agent"] = opts.ua;
  if (opts.testLogin) headers["x-test-login-token"] = TEST_LOGIN_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: opts.manualRedirect ? "manual" : "follow",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text; // the resolver's 302 body is empty
  }
  return { status: res.status, json, location: res.headers.get("location") };
}

/** Mint a REAL worker session through the gated D-3 seam. */
async function loginWorker(): Promise<{ workerId: string; token: string }> {
  const r = await req("POST", "/auth/test-login", {
    body: { phone: syntheticPhone() },
    testLogin: true,
  });
  expect(r.status, `test-login failed: ${JSON.stringify(r.json)}`).toBe(200);
  return { workerId: r.json.worker_id as string, token: r.json.access_token as string };
}

async function acceptConsent(token: string): Promise<void> {
  const r = await req("POST", "/consent/accept", {
    body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    token,
  });
  expect(r.status, `consent/accept failed: ${JSON.stringify(r.json)}`).toBe(201);
}

describe.skipIf(!RUN)("referral round-trip: /r/:code -> click -> attribute", () => {
  let client: DbClient;

  const clicksFor = async (code: string): Promise<Array<Record<string, any>>> => {
    const rows = await client.db.select().from(referralClicks);
    return rows.filter((r) => r.code === code);
  };

  const claimsFor = async (workerId: string): Promise<Array<Record<string, any>>> => {
    const rows = await client.db.select().from(referralClicks);
    return rows.filter((r) => r.claimedByWorkerId === workerId);
  };

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  it("302s an Android visitor to the App Link and logs exactly one click", async () => {
    const code = freshCode();

    const res = await req("GET", `/r/${code}`, { ua: ANDROID_UA, manualRedirect: true });
    expect(res.status).toBe(302);
    // The resolver's whole contract: never a dead end, and the code travels onward so the
    // Play Store referrer can still attribute the install.
    expect(res.location).toMatch(new RegExp(`/i/${code}$`));

    const rows = await clicksFor(code);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe("android");
    // No `referral_links` row exists for this code — the legacy fall-through leg, which is
    // the production path for every code minted before B4. It must still log.
    expect(rows[0]!.referralLinkId).toBeNull();
    expect(rows[0]!.claimedByWorkerId).toBeNull();
    // The raw IP/UA are never persisted — only the keyed HMAC.
    expect(rows[0]!.clickHash).toBeTruthy();
    expect(rows[0]!.clickHash).not.toContain("Android");
  });

  it("never dead-ends on a malformed code, and logs no click for it", async () => {
    const res = await req("GET", "/r/not-a-code", { ua: ANDROID_UA, manualRedirect: true });
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/\/i\/unknown$/);
    expect(await clicksFor("not-a-code")).toHaveLength(0);
  });

  it("claims the click on a CONSENTED worker's attribution, exactly once and only once", async () => {
    const code = freshCode();
    await req("GET", `/r/${code}`, { ua: ANDROID_UA, manualRedirect: true });

    const w = await loginWorker();
    await acceptConsent(w.token);

    const first = await req("POST", "/referrals/attribute", {
      token: w.token,
      body: { code, source: "app_link" },
    });
    // Fire-and-forget + constant-time by design: neutral regardless of outcome.
    expect(first.status).toBe(200);

    const claimed = await claimsFor(w.workerId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.code).toBe(code);
    expect(claimed[0]!.claimedAt).toBeTruthy();

    // FIRST TOUCH: a repeat claims nothing new. This is the partial unique index on
    // `claimed_by_worker_id` under a real second request.
    const second = await req("POST", "/referrals/attribute", {
      token: w.token,
      body: { code, source: "app_link" },
    });
    expect(second.status).toBe(200);
    expect(await claimsFor(w.workerId)).toHaveLength(1);
  });

  it("attributes NOTHING for a worker who has not consented (invariant #6)", async () => {
    const code = freshCode();
    await req("GET", `/r/${code}`, { ua: ANDROID_UA, manualRedirect: true });

    // Logged in, but no consent row — the DPDP gate must hold over HTTP, not only in the
    // service unit test.
    const w = await loginWorker();
    const res = await req("POST", "/referrals/attribute", {
      token: w.token,
      body: { code, source: "app_link" },
    });
    // Same neutral response as the consented path — no oracle.
    expect(res.status).toBe(200);

    expect(await claimsFor(w.workerId)).toHaveLength(0);
    const clicks = await clicksFor(code);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.claimedByWorkerId).toBeNull();
  });

  it("requires a session — an unauthenticated attribution is rejected outright", async () => {
    const res = await req("POST", "/referrals/attribute", {
      body: { code: freshCode(), source: "app_link" },
    });
    expect([401, 403]).toContain(res.status);
  });

  it("the bearer CODE never reaches the event spine", async () => {
    const code = freshCode();
    await req("GET", `/r/${code}`, { ua: ANDROID_UA, manualRedirect: true });
    const w = await loginWorker();
    await acceptConsent(w.token);
    await req("POST", "/referrals/attribute", {
      token: w.token,
      body: { code, source: "app_link" },
    });

    // EVERY event row, not just the ones we thought to look at — the code is a bearer
    // token and a single leak anywhere on a permanent audit record is the failure.
    const all = await client.db.select().from(events);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      expect(JSON.stringify(e.payload), `${e.eventName} leaked the bearer code`).not.toContain(
        code,
      );
    }

    // …and the claim DID land on the spine, so the assertion above is not vacuously true
    // just because nothing was emitted.
    expect(all.some((e) => e.eventName === "referral.install_claimed")).toBe(true);
  });
});
