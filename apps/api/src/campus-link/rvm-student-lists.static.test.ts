import "reflect-metadata";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #2772 — AN RVM STUDENT NEVER SHOWS IN A COMPANY LIST HE DID NOT APPLY TO.
 *
 * The rule (#2747 item 2, #2752; owner, 19 Nov 2026: only an admin decides visibility): a worker
 * with an ACTIVE `worker_institute_links` row shows to a company only on the applicant list of that
 * company's own job — unless an admin made him visible (#2887) or the company holds a named search
 * grant (#2752 item 10).
 *
 * There is no single place that rule lives: search filters him, applicant lists hold applicants
 * only, opened contacts pass the open gate first. So a NEW company route that returns workers
 * could forget it and nothing would notice. This test notices.
 *
 * IT DISCOVERS EVERY COMPANY ROUTE FROM DISK (the `canary-coverage.test.ts` method: import every
 * controller, read Nest's metadata) and requires each one to be classified below. A new company
 * route fails the build until someone states how it keeps an RVM student out; a classified route
 * that no longer exists fails too, so the list cannot rot.
 *
 * Company-facing = any guard whose name starts with `Payer` (PayerAuthGuard and its role guards),
 * or a path under `/payer/`. `/payers/:id/credits` is an ops route on InternalServiceGuard.
 *
 * The two classes that make a promise about rows (`excludes_linked`, `applicants_only`) are proven
 * against Postgres in `institute-tag-rules.db.test.ts` ("#2772 the company lists"); this test fails
 * if a route key in either class is not named there.
 */

/** How a company route keeps an actively linked RVM student out of lists he did not apply to. */
type RvmListClass =
  /** Returns no worker identity, card, count or fact (auth, account, billing, postings, chat). */
  | { kind: "no_workers" }
  /** Rows are applicants to the caller's own job (`a.action = 'applied'`), labelled. DB-proven. */
  | { kind: "applicants_only" }
  /** Filters active links unless admin-visible (#2887) or search-granted (#2752). DB-proven. */
  | { kind: "excludes_linked" }
  /**
   * Rows are contacts the caller already OPENED. The open itself is decided by InstituteOpenGate
   * (he applied to the company's job, or a grant), and an opened contact stays open for good
   * (#2747: "a credit opens the full contact for good").
   */
  | { kind: "opened_only" }
  /** The write that opens a contact: InstituteOpenGate refuses an RVM student who did not apply. */
  | { kind: "open_gated" }
  /**
   * The Managed Hiring tracker: only staff add workers, and `assertTrackable` refuses an RVM
   * student who did not apply to that job (`rvm_student_not_applied`).
   */
  | { kind: "staff_tracker" }
  /** A NUMBER of workers a posting reaches, no identities; RVM students are reached by BadaBhai jobs. */
  | { kind: "audience_count" }
  /**
   * Prices any ids the company sends (#2750 item 3). An RVM student the company could not open is
   * priced as an ordinary worker with the same facts (`InstituteOpenGate.quotesAsStudent`, #2954),
   * so a quote never tells it what he is.
   */
  | { kind: "quote_hides_student" }
  /** A known path that does not apply the rule, filed with the owner. */
  | { kind: "known_exception"; issue: `#${number}`; why: string };

const NONE: RvmListClass = { kind: "no_workers" };
const APPLICANTS: RvmListClass = { kind: "applicants_only" };
const EXCLUDES: RvmListClass = { kind: "excludes_linked" };
const OPENED: RvmListClass = { kind: "opened_only" };
const OPEN_GATED: RvmListClass = { kind: "open_gated" };
const COUNT: RvmListClass = { kind: "audience_count" };

/** Every company route, classified. A new one is added here with its class, or the build fails. */
const COMPANY_ROUTES: Readonly<Record<string, RvmListClass>> = {
  // ── Lists of people ─────────────────────────────────────────────────────────────────────────
  "POST /payer/candidates/search": EXCLUDES,
  "GET /payer/candidates/filters": EXCLUDES, // the city facet, built from the same pool
  "GET /payer/reach/jobs/:P/applicants": APPLICANTS,
  "GET /payer/reach/applicants": APPLICANTS,
  "PUT /payer/reach/jobs/:P/applicants/:P/stage": APPLICANTS, // 404 unless an applicant
  "GET /payer/managed-hiring/orders": { kind: "staff_tracker" },
  "GET /payer/managed-hiring/orders/:P": { kind: "staff_tracker" },
  "GET /payer/agency/workers": {
    kind: "known_exception",
    issue: "#2954",
    why: "an agency sees the workers it referred who consented to agent visibility, RVM link or not",
  },
  // ── Opened contacts and the writes that open them ───────────────────────────────────────────
  "POST /payer/unlocks": OPEN_GATED,
  "POST /payer/resume-disclosures": OPEN_GATED,
  "GET /payer/unlocks": OPENED,
  "GET /payer/unlocks/:P/contact": OPENED,
  "POST /payer/unlocks/:P/reveal": OPENED,
  "GET /payer/unlocks/:P/couldnt-reach": OPENED,
  "POST /payer/unlocks/:P/couldnt-reach": OPENED,
  "POST /payer/unlocks/:P/outcome": OPENED,
  "GET /payer/unlock-outcomes/due": OPENED,
  "GET /payer/resume-disclosures": OPENED,
  "GET /payer/relay/:P/messages": OPENED, // keyed on the opened contact's relay handle
  "POST /payer/relay/:P/messages": OPENED,
  "POST /payer/unlocks/quotes": { kind: "quote_hides_student" },
  // ── Counts ──────────────────────────────────────────────────────────────────────────────────
  "POST /payer/match/reach-preview": COUNT,
  "POST /payer/job-postings/:P/boost": COUNT, // the supply-gate refusal states a reach count
  // ── No workers ──────────────────────────────────────────────────────────────────────────────
  "DELETE /payer/org/members/:P": NONE,
  "GET /payer/agency/earnings": NONE,
  "GET /payer/agency/jobs": NONE,
  "GET /payer/agency/jobs/:P": NONE,
  "GET /payer/agency/kyc": NONE,
  "GET /payer/agency/payouts": NONE,
  "GET /payer/agency/referrals/summary": NONE, // floored counts only
  "GET /payer/billing-details": NONE,
  "GET /payer/campus-drive-requests": NONE,
  "GET /payer/campus-drive-requests/:P": NONE,
  "GET /payer/capacity": NONE,
  "GET /payer/credit-notes/:P/download": NONE,
  "GET /payer/credits": NONE,
  "GET /payer/credits/ledger": NONE,
  "GET /payer/invoices": NONE,
  "GET /payer/invoices/:P/download": NONE,
  "GET /payer/job-posting-chat/sessions": NONE,
  "GET /payer/job-posting-chat/sessions/:P/messages": NONE,
  "GET /payer/job-postings": NONE,
  "GET /payer/job-postings/:P": NONE, // the posting and its counts
  "GET /payer/job-postings/audience-options": NONE,
  "GET /payer/job-postings/posting-options": NONE,
  "GET /payer/managed-hiring/quote": NONE,
  "GET /payer/match/skills": NONE,
  "GET /payer/me": NONE,
  "GET /payer/me/display-prefs": NONE,
  "GET /payer/me/phone-proof": NONE,
  "GET /payer/org/members": NONE, // the company's own team
  "GET /payer/posting-trades": NONE,
  "GET /payer/pricing/catalog": NONE,
  "GET /payer/reach/applicant-stages": NONE,
  "GET /payer/relay/templates": NONE,
  "PATCH /payer/agency/jobs/:P": NONE,
  "PATCH /payer/job-postings/:P": NONE,
  "PATCH /payer/me": NONE,
  "PATCH /payer/me/display-prefs": NONE,
  "POST /payer/agency/invites": NONE,
  "POST /payer/agency/invites/:P/click": NONE,
  "POST /payer/agency/invites/batch": NONE,
  "POST /payer/agency/jobs": NONE,
  "POST /payer/agency/jobs/:P/close": NONE,
  "POST /payer/agency/jobs/:P/pause": NONE,
  "POST /payer/agency/jobs/:P/resume": NONE,
  "POST /payer/agency/kyc": NONE,
  "POST /payer/agency/payouts": NONE,
  "POST /payer/campus-drive-requests": NONE,
  "POST /payer/campus-drive-requests/:P/cancel": NONE,
  "POST /payer/capacity": NONE,
  "POST /payer/credits": NONE,
  "POST /payer/credits/order": NONE,
  "POST /payer/credits/verify": NONE,
  "POST /payer/job-posting-chat/message": NONE,
  "POST /payer/job-posting-chat/session": NONE,
  "POST /payer/job-posting-chat/sessions/:P/publish": NONE,
  "POST /payer/job-postings": NONE,
  "POST /payer/job-postings/:P/close": NONE,
  "POST /payer/job-postings/:P/pause": NONE,
  "POST /payer/job-postings/:P/plan": NONE,
  "POST /payer/job-postings/:P/quota-topup": NONE,
  "POST /payer/job-postings/:P/resume": NONE,
  "POST /payer/job-postings/description/draft": NONE,
  "POST /payer/login/password": NONE,
  "POST /payer/login/request": NONE,
  "POST /payer/login/verify": NONE,
  "POST /payer/logout": NONE,
  "POST /payer/managed-hiring/callback-requests": NONE,
  "POST /payer/managed-hiring/orders": NONE,
  "POST /payer/me/delete/immediate": NONE,
  "POST /payer/me/phone-proof": NONE,
  "POST /payer/me/phone-proof/verify": NONE,
  "POST /payer/org/invites/accept": NONE,
  "POST /payer/org/members": NONE,
  "POST /payer/password/set": NONE,
  "POST /payer/refresh": NONE,
  "POST /payer/signup": NONE,
  "POST /payer/test-login": NONE,
  "PUT /payer/billing-details": NONE,
};

// ── Route discovery (the canary-coverage.test.ts method) ─────────────────────────────────────

const API_SRC = join(__dirname, "..");
const DB_PROOF = join(__dirname, "institute-tag-rules.db.test.ts");
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];

function findControllers(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findControllers(full, out);
    else if (entry.endsWith(".controller.ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function guardNames(target: unknown): string[] {
  const g = Reflect.getMetadata("__guards__", target as object) as
    | Array<{ name?: string }>
    | undefined;
  return (g ?? []).map((x) => x?.name ?? String(x));
}

function joinPath(base: string, sub: string): string {
  const b = (base ?? "").replace(/^\/|\/$/g, "");
  const s = (sub ?? "").replace(/^\/|\/$/g, "");
  return "/" + [b, s].filter(Boolean).join("/");
}

/** `/payer/unlocks/:unlockId` and `/payer/unlocks/:id` compare equal. */
function normalize(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":P" : seg))
    .join("/");
}

async function collectCompanyRoutes(): Promise<{ routes: Map<string, string>; unimportable: string[] }> {
  const routes = new Map<string, string>();
  const unimportable: string[] = [];
  for (const file of findControllers(API_SRC)) {
    const rel = relative(API_SRC, file).split(sep).join("/");
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      // Reported, never skipped: a controller we cannot load is one we cannot classify.
      unimportable.push(`${rel} — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      continue;
    }
    for (const exported of Object.values(mod)) {
      if (typeof exported !== "function") continue;
      const proto = (exported as { prototype?: object }).prototype;
      if (!proto) continue;
      const base = Reflect.getMetadata("path", exported) as string | undefined;
      if (base === undefined) continue; // not a @Controller
      const classGuards = guardNames(exported);
      for (const fn of Object.getOwnPropertyNames(proto)) {
        if (fn === "constructor") continue;
        const handler = (proto as Record<string, unknown>)[fn];
        if (typeof handler !== "function") continue;
        const sub = Reflect.getMetadata("path", handler) as string | undefined;
        if (sub === undefined) continue; // not a route
        const path = joinPath(base, sub);
        const guards = [...classGuards, ...guardNames(handler)];
        if (!guards.some((g) => g.startsWith("Payer")) && !path.startsWith("/payer/")) continue;
        const method = METHODS[(Reflect.getMetadata("method", handler) as number | undefined) ?? 0];
        routes.set(`${method} ${normalize(path)}`, `${rel} ${fn}`);
      }
    }
  }
  return { routes, unimportable };
}

// Importing every controller is slow on a loaded machine (and ~20x slower on CI): a generous timeout.
const DISCOVERY_TIMEOUT_MS = 180_000;

describe("#2772 every company route says how it keeps an RVM student out of lists he did not apply to", () => {
  let discovered: Promise<{ routes: Map<string, string>; unimportable: string[] }> | undefined;
  const discover = () => (discovered ??= collectCompanyRoutes());

  it(
    "imports every controller and finds a non-trivial set of company routes (never vacuous)",
    async () => {
      expect(findControllers(API_SRC).length).toBeGreaterThanOrEqual(50);
      const { routes, unimportable } = await discover();
      expect(unimportable).toEqual([]);
      expect(routes.size).toBeGreaterThanOrEqual(80);
      expect(routes.has("POST /payer/candidates/search")).toBe(true);
    },
    DISCOVERY_TIMEOUT_MS,
  );

  it(
    "every discovered company route is classified (a new one must be added to COMPANY_ROUTES)",
    async () => {
      const { routes } = await discover();
      const missing = [...routes.entries()]
        .filter(([key]) => !(key in COMPANY_ROUTES))
        .map(([key, where]) => `${key}  (${where})`);
      expect(missing, "classify each new company route in rvm-student-lists.static.test.ts").toEqual([]);
    },
    DISCOVERY_TIMEOUT_MS,
  );

  it(
    "every classified route still exists (a stale entry hides nothing and must go)",
    async () => {
      const { routes } = await discover();
      const stale = Object.keys(COMPANY_ROUTES).filter((key) => !routes.has(key));
      expect(stale).toEqual([]);
    },
    DISCOVERY_TIMEOUT_MS,
  );

  it("every route that promises something about its rows is proven in the DB test", () => {
    const proof = readFileSync(DB_PROOF, "utf8");
    const promised = Object.entries(COMPANY_ROUTES)
      .filter(([, c]) => c.kind === "excludes_linked" || c.kind === "applicants_only")
      .map(([key]) => key);
    expect(promised.length).toBeGreaterThanOrEqual(4);
    const unproven = promised.filter((key) => !proof.includes(key));
    expect(unproven, "name each route in the '#2772 the company lists' block of the DB test").toEqual([]);
  });

  it("every known exception names its issue and why", () => {
    for (const [key, c] of Object.entries(COMPANY_ROUTES)) {
      if (c.kind !== "known_exception") continue;
      expect(c.issue, key).toMatch(/^#\d+$/);
      expect(c.why.trim().length, key).toBeGreaterThan(20);
    }
  });
});
