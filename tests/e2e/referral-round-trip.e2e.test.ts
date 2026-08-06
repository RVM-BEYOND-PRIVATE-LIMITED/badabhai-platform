import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  agencyInvites,
  events,
  referralClicks,
  type DbClient,
} from "@badabhai/db";
import { mintPayerSession } from "./helpers/payer-session";

/**
 * THE REFERRAL ROUND-TRIP — mint → share → click → install → attribution.
 *
 * This is the suite the funnel never had. Every stage of the agency referral loop was unit
 * tested in isolation, but nothing exercised the JOIN between them, and the join is where
 * the interesting failures live: the mint writes to `agency_invites`, the click writes to
 * `referral_clicks`, and the claim reconciles the two through a code that is deliberately
 * NOT carried on any event. A per-layer mock cannot catch a mismatch between those spaces —
 * only a real code travelling through real HTTP can.
 *
 * WHAT IT PROVES
 *  1. `POST /payer/agency/invites` mints a real row carrying the W1 metadata (0068).
 *  2. `GET /r/:code` — with an ANDROID user-agent and no session — 302s to the App Link
 *     and logs exactly one `referral_clicks` row for that code.
 *  3. `POST /referrals/attribute` (worker-authed, post-consent) claims that click ONCE and
 *     advances the invite to `accepted`.
 *  4. FIRST-TOUCH IS IDEMPOTENT: re-posting the same attribution claims nothing new. This is
 *     the partial unique index on `claimed_by_worker_id` doing its job end-to-end, not a
 *     unit test's stubbed conflict.
 *  5. THE CODE IS NEVER ON THE SPINE. The bearer code appears in no event payload from any
 *     stage of the loop — the rule `invite.clicked` has followed since ADR-0020, asserted
 *     here against every event the whole round-trip produced.
 *  6. The context slug VALUES stay on the row; only their KEY NAMES reach the event.
 *
 * Opt-in (requires a running API + Postgres + Redis):
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate
 *   3. pnpm --filter @badabhai/api start
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 */

const RUN = process.env.RUN_E2E === "1";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-06-01";

// A real Android UA: `platformFromUserAgent` must classify this as 'android' so the
// resolver takes the App-Link leg rather than the desktop QR page. A UA that reads as a
// bot logs NO click at all (isLikelyBot), which would make this suite silently vacuous.
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ua?: string; manualRedirect?: boolean } = {},
): Promise<{ status: number; json: any; location: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.ua) headers["user-agent"] = opts.ua;
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
    json = text; // the resolver's 302 body is empty; a landing page would be HTML
  }
  return { status: res.status, json, location: res.headers.get("location") };
}

/** Login a fresh worker (mock OTP) and return its id + bearer token. */
async function loginWorker(): Promise<{ workerId: string; token: string }> {
  const phone = `+9196${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`.slice(0, 13);
  const r1 = await req("POST", "/auth/otp/request", { body: { phone } });
  expect(r1.status).toBe(200);
  const r2 = await req("POST", "/auth/otp/verify", { body: { phone, otp: r1.json.dev_otp } });
  expect(r2.status).toBe(200);
  return { workerId: r2.json.worker_id as string, token: r2.json.access_token as string };
}

async function acceptConsent(token: string): Promise<void> {
  const r = await req("POST", "/consent/accept", {
    body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    token,
  });
  expect(r.status).toBe(201);
}

describe.skipIf(!RUN)("referral round-trip: mint -> /r/:code -> attribute", () => {
  let client: DbClient;
  let agentToken: string;
  let agentPayerId: string;

  // Captured once in the happy-path test and reused by the assertions after it, so the
  // whole loop runs exactly once (a re-mint would be a different code and a different row).
  let code: string;
  let inviteId: string;
  let workerId: string;
  let workerToken: string;

  const clicksForCode = async (): Promise<Array<Record<string, any>>> => {
    const rows = await client.db.select().from(referralClicks);
    return rows.filter((r) => r.code === code);
  };

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    const agent = await mintPayerSession({ role: "agent", apiUrl: API_URL });
    agentToken = agent.token;
    agentPayerId = agent.payerId;
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  it("mints an invite carrying the W1 metadata, and returns the /i/<code> share link", async () => {
    const res = await req("POST", "/payer/agency/invites", {
      token: agentToken,
      body: {
        campaign: "gate-drive-2026",
        medium: "paid",
        context: { role: "welder", city: "pune" },
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);

    code = res.json.code as string;
    inviteId = res.json.agency_invite_id as string;
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(res.json.link).toBe(`/i/${code}`);

    const rows = await client.db.select().from(agencyInvites);
    const row = rows.find((r) => r.id === inviteId);
    expect(row?.inviterPayerId).toBe(agentPayerId);
    expect(row?.campaign).toBe("gate-drive-2026");
    expect(row?.medium).toBe("paid");
    // The VALUES live here and only here.
    expect(row?.payload).toEqual({ role: "welder", city: "pune" });
    expect(row?.status).toBe("created");
  });

  it("rejects a context key outside the closed set, rather than storing it", async () => {
    const res = await req("POST", "/payer/agency/invites", {
      token: agentToken,
      body: { context: { phone: "9822000000" } },
    });
    // `.strict()` at the boundary — a loud 400, never a silently stripped key.
    expect(res.status).toBe(400);
  });

  it("GET /r/:code 302s an Android visitor to the App Link and logs exactly one click", async () => {
    const before = (await clicksForCode()).length;

    const res = await req("GET", `/r/${code}`, { ua: ANDROID_UA, manualRedirect: true });
    expect(res.status).toBe(302);
    // The whole point of the resolver: it never dead-ends, and it carries the code onward.
    expect(res.location).toMatch(new RegExp(`/i/${code}$`));

    const rows = await clicksForCode();
    expect(rows.length - before).toBe(1);

    const click = rows[0]!;
    expect(click.platform).toBe("android");
    // A legacy (`agency_invites`) code has no `referral_links` row — this is the
    // fall-through leg, and it must still log. `referral_links` is measurement-only.
    expect(click.referralLinkId).toBeNull();
    expect(click.claimedByWorkerId).toBeNull();
    // The raw IP/UA are never persisted — only the keyed HMAC.
    expect(click.clickHash).toBeTruthy();
    expect(click.clickHash).not.toContain("Android");
  });

  it("claims the click exactly once on the consented worker's attribution post", async () => {
    const w = await loginWorker();
    workerId = w.workerId;
    workerToken = w.token;
    await acceptConsent(workerToken);

    const res = await req("POST", "/referrals/attribute", {
      token: workerToken,
      body: { code, source: "app_link" },
    });
    // Fire-and-forget + constant-time by design: the response is neutral regardless.
    expect(res.status).toBe(201);

    const claimed = (await clicksForCode()).filter((r) => r.claimedByWorkerId === workerId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.claimedAt).toBeTruthy();

    // …and the agency funnel advanced through the consent-gated seam.
    const rows = await client.db.select().from(agencyInvites);
    const invite = rows.find((r) => r.id === inviteId);
    expect(invite?.status).toBe("accepted");
    expect(invite?.invitedWorkerId).toBe(workerId);
    // The 90-day payout-window anchor is stamped with the attribution, not later.
    expect(invite?.attributedAt).toBeTruthy();
  });

  it("FIRST TOUCH: a repeat attribution claims nothing new (partial unique index holds)", async () => {
    const res = await req("POST", "/referrals/attribute", {
      token: workerToken,
      body: { code, source: "app_link" },
    });
    expect(res.status).toBe(201);

    const claimed = (await clicksForCode()).filter((r) => r.claimedByWorkerId === workerId);
    // Still exactly one, EVER — this is the index, not application politeness.
    expect(claimed).toHaveLength(1);
  });

  it("the bearer CODE never reaches the event spine, at any stage of the loop", async () => {
    const all = await client.db.select().from(events);
    const mine = all.filter((e) => e.subjectType === "agency_invite" && e.subjectId === inviteId);
    expect(mine.length).toBeGreaterThan(0);

    for (const e of mine) {
      const wire = JSON.stringify(e.payload);
      expect(wire, `${e.eventName} leaked the bearer code`).not.toContain(code);
      // Context VALUES stay on the row; only the key names are emitted.
      expect(wire, `${e.eventName} leaked a context value`).not.toContain("welder");
      expect(wire, `${e.eventName} leaked a context value`).not.toContain("pune");
    }

    const created = mine.find((e) => e.eventName === "agency_invite.created");
    expect(created).toBeTruthy();
    const payload = created!.payload as Record<string, unknown>;
    expect(payload.medium).toBe("paid");
    expect(payload.campaign).toBe("gate-drive-2026");
    expect(payload.payload_keys).toEqual(["city", "role"]);
  });
});
