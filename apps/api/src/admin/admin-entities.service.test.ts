import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminEntitiesService } from "./admin-entities.service";
import type { AdminEntitiesRepository } from "./admin-entities.repository";
import type { AdminIdentityService } from "./admin-identity.service";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";

/**
 * The service owns two things — keyset paging, and merging in the names the identity layer
 * decided this admin may see — so that is what this file tests, hard.
 *
 * Paging bugs are the quiet kind: an off-by-one at a page boundary silently drops a row from
 * an operations list, and nothing anywhere reports an error. The operator just never sees that
 * worker.
 */

const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };
const admin = (role: AdminRole = "ops_admin"): AuthenticatedAdmin => ({
  id: "admin-1",
  role,
  sid: "s",
});

function repoStub(overrides: Partial<AdminEntitiesRepository> = {}): AdminEntitiesRepository {
  return {
    listWorkers: vi.fn(async () => []),
    findWorker: vi.fn(async () => undefined),
    listPayers: vi.fn(async () => []),
    findPayer: vi.fn(async () => undefined),
    listJobPostings: vi.fn(async () => []),
    findJobPosting: vi.fn(async () => undefined),
    listApplications: vi.fn(async () => []),
    getCreditBalance: vi.fn(async () => 0),
    listCreditLedger: vi.fn(async () => []),
    ...overrides,
  } as unknown as AdminEntitiesRepository;
}

/**
 * An identity layer that discloses NOTHING by default — the faceless posture every paging test
 * below is written against, and the real behaviour for a role without `read_identity`.
 */
function identityStub(
  resolve: AdminIdentityService["resolve"] = vi.fn(async () => null),
  isPermitted = false,
): AdminIdentityService {
  return { resolve, isPermitted: vi.fn(() => isPermitted) } as unknown as AdminIdentityService;
}

/** An identity layer that DOES disclose — the posture of a super_admin / ops_admin / support. */
function permittedIdentity(
  resolve: AdminIdentityService["resolve"] = vi.fn(async () => new Map()),
): AdminIdentityService {
  return identityStub(resolve, true);
}

function service(
  overrides: Partial<AdminEntitiesRepository> = {},
  identity: AdminIdentityService = identityStub(),
): AdminEntitiesService {
  return new AdminEntitiesService(repoStub(overrides), identity);
}

/** `n` rows with strictly decreasing timestamps, newest first — the real list ordering. */
function rows(n: number, base = Date.parse("2026-08-04T12:00:00Z")) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    created_at: new Date(base - i * 1000),
  }));
}

describe("keyset paging — the page boundary", () => {
  it("over-fetches by exactly one: a page of N asks the repository for N+1", async () => {
    const listWorkers = vi.fn(async () => []);
    const svc = service({ listWorkers } as never);
    await svc.listWorkers(admin(), { limit: 25 } as never, CTX);
    expect(listWorkers).toHaveBeenCalledWith(expect.anything(), null, 26);
  });

  it("returns exactly `limit` items and a cursor when a further row exists", async () => {
    const svc = service({ listWorkers: vi.fn(async () => rows(6)) } as never);
    const page = await svc.listWorkers(admin(), { limit: 5 } as never, CTX);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    // The cursor points at the LAST RETURNED row (index 4), never at the peeked 6th — pointing
    // at the peeked row would skip it on the next page.
    expect(decodeEntityCursor(page.nextCursor!)).toEqual({
      createdAt: rows(6)[4]!.created_at.toISOString(),
      id: "id-4",
    });
  });

  it("a FULL last page reports nextCursor null — no phantom empty page", async () => {
    // The bug this pins: deriving "there is more" from `items.length === limit` shows a Next
    // button whenever the total is an exact multiple of the page size, and the operator lands
    // on an empty screen that reads like data loss.
    const svc = service({ listWorkers: vi.fn(async () => rows(5)) } as never);
    const page = await svc.listWorkers(admin(), { limit: 5 } as never, CTX);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("an empty result is an empty page, not a cursor to nowhere", async () => {
    const svc = service();
    const page = await svc.listWorkers(admin(), { limit: 10 } as never, CTX);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("passes a decoded cursor through to the repository", async () => {
    const listPayers = vi.fn(async () => []);
    const svc = service({ listPayers } as never);
    const cursor = encodeEntityCursor({ createdAt: "2026-08-04T12:00:00.000Z", id: "x" });
    await svc.listPayers(admin(), { limit: 10, cursor } as never, CTX);
    expect(listPayers).toHaveBeenCalledWith(
      expect.anything(),
      { createdAt: "2026-08-04T12:00:00.000Z", id: "x" },
      11,
    );
  });

  it("a GARBAGE cursor is treated as the first page, never as an error", async () => {
    const listPayers = vi.fn(async () => []);
    const svc = service({ listPayers } as never);
    await svc.listPayers(admin(), { limit: 10, cursor: "not-a-real-cursor" } as never, CTX);
    expect(listPayers).toHaveBeenCalledWith(expect.anything(), null, 11);
  });
});

describe("filters reach the repository verbatim", () => {
  it("worker filters (status + pendingDeletion) are forwarded", async () => {
    const listWorkers = vi.fn(async () => []);
    const svc = service({ listWorkers } as never);
    await svc.listWorkers(
      admin(),
      { limit: 10, status: "suspended", pendingDeletion: true } as never,
      CTX,
    );
    expect(listWorkers).toHaveBeenCalledWith(
      { status: "suspended", pendingDeletion: true },
      null,
      11,
    );
  });

  it("payer role is forwarded — it is what splits Companies from Agencies", async () => {
    const listPayers = vi.fn(async () => []);
    const svc = service({ listPayers } as never);
    await svc.listPayers(admin(), { limit: 10, role: "agent" } as never, CTX);
    expect(listPayers).toHaveBeenCalledWith({ role: "agent", status: undefined }, null, 11);
  });

  it("job-posting filters are forwarded", async () => {
    const listJobPostings = vi.fn(async () => []);
    const svc = service({ listJobPostings } as never);
    await svc.listJobPostings({
      limit: 10,
      status: "open",
      verificationStatus: "unverified",
      payerId: "p1",
    } as never);
    expect(listJobPostings).toHaveBeenCalledWith(
      { status: "open", verificationStatus: "unverified", payerId: "p1" },
      null,
      11,
    );
  });
});

describe("a missing entity is 404, never an empty-shaped 200", () => {
  it("getWorker throws NotFound", async () => {
    const svc = service();
    await expect(svc.getWorker(admin(), "missing", CTX)).rejects.toThrow(NotFoundException);
  });

  it("getPayer throws NotFound", async () => {
    const svc = service();
    await expect(svc.getPayer(admin(), "missing", CTX)).rejects.toThrow(NotFoundException);
  });

  it("getJobPosting throws NotFound", async () => {
    const svc = service();
    await expect(svc.getJobPosting("missing")).rejects.toThrow(NotFoundException);
  });
});

describe("credits — balance and ledger travel together", () => {
  it("returns the balance alongside a paged ledger", async () => {
    const svc = service({
      getCreditBalance: vi.fn(async () => 42),
      listCreditLedger: vi.fn(async () => rows(3)),
    } as never);
    const view = await svc.getCredits("payer-1", { limit: 10 } as never);
    expect(view).toMatchObject({ payer_id: "payer-1", balance: 42 });
    expect(view.ledger.items).toHaveLength(3);
    expect(view.ledger.nextCursor).toBeNull();
  });

  it("a payer with NO credits row reads 0 — a real zero, not an unavailable state", async () => {
    const svc = service();
    const view = await svc.getCredits("payer-1", { limit: 10 } as never);
    expect(view.balance).toBe(0);
  });

  it("the ledger page is scoped to the requested payer", async () => {
    const listCreditLedger = vi.fn(async () => []);
    const svc = service({ listCreditLedger } as never);
    await svc.getCredits("payer-9", { limit: 10 } as never);
    expect(listCreditLedger).toHaveBeenCalledWith("payer-9", null, 11);
  });
});

// ---------------------------------------------------------------------------
// NAMES (owner ruling 2026-08-18) — what the identity layer decides, and what this service
// does with the answer. The gate itself is tested in `admin-identity.service.test.ts`; here
// the question is whether this service asks the right question and merges the right rows.
// ---------------------------------------------------------------------------

describe("names — the service merges exactly what identity disclosed", () => {
  it("a DISCLOSING resolve puts full_name on every returned worker row", async () => {
    const resolve = vi.fn(async () => new Map([["id-0", "Ramesh Kumar"]]));
    const svc = service({ listWorkers: vi.fn(async () => rows(2)) } as never, identityStub(
      resolve as never,
    ));
    const page = await svc.listWorkers(admin(), { limit: 5 } as never, CTX);
    expect(page.items[0]).toMatchObject({ id: "id-0", full_name: "Ramesh Kumar" });
    // A row the map has no entry for still CARRIES the field, as null — "disclosed, and this
    // person has no name on record". Omitting it there would be indistinguishable from the
    // not-entitled response.
    expect(page.items[1]).toMatchObject({ id: "id-1", full_name: null });
  });

  it("a NON-disclosing resolve leaves the page byte-identical to the faceless one", async () => {
    // The `read_identity`-less path, and the one that must never regress: an analyst's response
    // is today's response, with no `full_name` KEY at all — not a null, which would claim the
    // name was disclosed and found empty.
    const svc = service({ listWorkers: vi.fn(async () => rows(2)) } as never);
    const page = await svc.listWorkers(admin("analyst"), { limit: 5 } as never, CTX);
    expect(page.items[0]).not.toHaveProperty("full_name");
    expect(Object.keys(page.items[0]!).sort()).toEqual(["created_at", "id"]);
  });

  it("asks for the RETURNED page only — never the peeked `limit + 1` row", async () => {
    // Auditing (and charging the name budget for) a row the admin was never shown would make
    // both the trail and the cap describe reading that did not happen. Six rows come back for a
    // page of five; exactly five ids may be resolved.
    const resolve = vi.fn(async () => new Map());
    const svc = service({ listWorkers: vi.fn(async () => rows(6)) } as never, identityStub(
      resolve as never,
    ));
    await svc.listWorkers(admin(), { limit: 5 } as never, CTX);
    expect(resolve).toHaveBeenCalledWith(
      expect.anything(),
      "workers",
      ["id-0", "id-1", "id-2", "id-3", "id-4"],
      null,
      CTX,
    );
  });

  it("a LIST resolves with subject_id null; a DETAIL resolves with the entity id", async () => {
    const resolve = vi.fn(async () => new Map());
    const identity = identityStub(resolve as never);
    const svc = service(
      { findWorker: vi.fn(async () => ({ id: "w-1" })), listPayers: vi.fn(async () => []) } as never,
      identity,
    );
    await svc.getWorker(admin(), "w-1", CTX);
    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), "workers", ["w-1"], "w-1", CTX);
    await svc.listPayers(admin(), { limit: 5 } as never, CTX);
    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), "payers", [], null, CTX);
  });

  it("payers get org_name, from the `payers` surface — never the workers one", async () => {
    const resolve = vi.fn(async () => new Map([["id-0", "Sharma Fabrication Pvt Ltd"]]));
    const svc = service({ listPayers: vi.fn(async () => rows(1)) } as never, identityStub(
      resolve as never,
    ));
    const page = await svc.listPayers(admin(), { limit: 5 } as never, CTX);
    expect(page.items[0]).toMatchObject({ org_name: "Sharma Fabrication Pvt Ltd" });
    expect(resolve).toHaveBeenCalledWith(expect.anything(), "payers", ["id-0"], null, CTX);
  });

  it("a 404 short-circuits BEFORE any name is resolved (no budget spent, no audit row)", async () => {
    const resolve = vi.fn(async () => new Map());
    const svc = service({}, identityStub(resolve as never));
    await expect(svc.getWorker(admin(), "missing", CTX)).rejects.toThrow(NotFoundException);
    expect(resolve).not.toHaveBeenCalled();
  });

  // ── THE PAYER LIMB ──────────────────────────────────────────────────────────────────────
  // Every assertion above about `full_name` had a `listPayers`/`getPayer` twin that was NOT
  // covered, and all three of the following mutations were MEASURED to survive the entire
  // 929-test admin suite before these tests existed. The shape of the gap was uniform: the
  // worker path was pinned to the mutation bar, the payer path was pinned for `listPayers`'
  // surface, clamp and cursor and nothing else.

  it("getPayer 404s BEFORE any name is resolved (no budget spent, no audit row)", async () => {
    // MUTATION THIS CATCHES: hoisting `this.identity.resolve(...)` above the `findPayer` /
    // NotFoundException lines. A payer id that does not exist would then spend name budget and
    // commit an `admin.identity_viewed` row for a disclosure that cannot happen. The worker
    // mirror was pinned; this one was not, and the mutation shipped green.
    const resolve = vi.fn(async () => new Map());
    const svc = service({ findPayer: vi.fn(async () => undefined) } as never, identityStub(
      resolve as never,
    ));
    await expect(svc.getPayer(admin(), "missing", CTX)).rejects.toThrow(NotFoundException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("getPayer MERGES the disclosed org_name onto the returned detail", async () => {
    // MUTATION THIS CATCHES: replacing the merge with a bare `await this.identity.resolve(...);
    // return payer;`. The console would spend the budget, write the audit row and decrypt the
    // name — and then never return it, so every company/agency detail view silently loses its
    // org name while the spine records that it was disclosed. The static guard cannot see this:
    // it derives name-bearing handlers by scanning for `this.identity.resolve(`, which the
    // mutation keeps.
    const resolve = vi.fn(async () => new Map([["p-1", "Sharma Fabrication Pvt Ltd"]]));
    const svc = service(
      { findPayer: vi.fn(async () => ({ id: "p-1", role: "employer" })) } as never,
      identityStub(resolve as never),
    );
    const payer = await svc.getPayer(admin(), "p-1", CTX);
    expect(payer).toMatchObject({ id: "p-1", org_name: "Sharma Fabrication Pvt Ltd" });
    expect(resolve).toHaveBeenCalledWith(expect.anything(), "payers", ["p-1"], "p-1", CTX);
  });

  it("getPayer keeps org_name ABSENT when identity disclosed nothing", async () => {
    // The other half of the three-state contract on the detail read: not a null, which would
    // claim the name was disclosed and found empty.
    const svc = service(
      { findPayer: vi.fn(async () => ({ id: "p-1", role: "employer" })) } as never,
    );
    const payer = await svc.getPayer(admin("analyst"), "p-1", CTX);
    expect(payer).not.toHaveProperty("org_name");
  });

  it("listPayers asks for the RETURNED page only — never the peeked `limit + 1` row", async () => {
    // MUTATION THIS CATCHES: `page.items.map((p) => p.id)` → `rows.map((p) => p.id)`. Every
    // payer page would audit and charge one name more than the admin was shown — the audit trail
    // and the egress budget both describing reading that did not happen, which is the exact
    // property the `listWorkers` twin of this test exists to protect.
    const resolve = vi.fn(async () => new Map());
    const svc = service({ listPayers: vi.fn(async () => rows(6)) } as never, identityStub(
      resolve as never,
    ));
    await svc.listPayers(admin(), { limit: 5 } as never, CTX);
    expect(resolve).toHaveBeenCalledWith(
      expect.anything(),
      "payers",
      ["id-0", "id-1", "id-2", "id-3", "id-4"],
      null,
      CTX,
    );
  });

  it("the SESSION admin is what gets handed to the gate — never anything from the DTO", async () => {
    const resolve = vi.fn(async () => new Map());
    const svc = service({}, identityStub(resolve as never));
    const who = admin("support");
    await svc.listWorkers(who, { limit: 5 } as never, CTX);
    expect(resolve).toHaveBeenCalledWith(who, "workers", [], null, CTX);
  });

  it("a NAME-BEARING page is clamped to 50 — the query, the page, and the names alike", async () => {
    // The clamp is applied BEFORE the query, so `?limit=100` from a permitted admin is a
    // 50-row read, not a 100-row read with half the answer thrown away. All three numbers move
    // together or the control is only cosmetic: the repository is asked for 51 (50 + the peek),
    // the page is 50, and exactly 50 ids are handed to the identity layer.
    const resolve = vi.fn(async () => new Map());
    const listWorkers = vi.fn(async () => rows(51));
    const svc = service({ listWorkers } as never, permittedIdentity(resolve as never));

    const page = await svc.listWorkers(admin(), { limit: 100 } as never, CTX);

    expect(listWorkers).toHaveBeenCalledWith(expect.anything(), null, 51);
    expect(page.items).toHaveLength(50);
    expect((resolve.mock.calls[0] as unknown[])[2] as string[]).toHaveLength(50);
  });

  it("...and the clamped page's nextCursor points at row 50, not row 100", async () => {
    // The paging half. A clamp that shrank the page but left the cursor derived from the
    // requested limit would skip rows 50–99 on the next page — an operations list silently
    // losing half its rows, with nothing anywhere reporting an error.
    const listPayers = vi.fn(async () => rows(51));
    const svc = service({ listPayers } as never, permittedIdentity());
    const page = await svc.listPayers(admin(), { limit: 100 } as never, CTX);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeEntityCursor(page.nextCursor!)).toEqual({
      createdAt: rows(51)[49]!.created_at.toISOString(),
      id: "id-49",
    });
  });

  it("the FACELESS path keeps its full 100 ceiling — an analyst's page does not shrink", async () => {
    // The ruling clamps the NAME-bearing path. Shrinking the faceless read too would be an
    // identity control quietly degrading the `read_entities` floor all four roles hold.
    const listWorkers = vi.fn(async () => rows(101));
    const svc = service({ listWorkers } as never, identityStub());
    const page = await svc.listWorkers(admin("analyst"), { limit: 100 } as never, CTX);
    expect(listWorkers).toHaveBeenCalledWith(expect.anything(), null, 101);
    expect(page.items).toHaveLength(100);
  });

  it("the clamp only ever SHRINKS: a request under 50 is passed through untouched", async () => {
    // `Math.min`, not "always 50". A permitted admin asking for 10 rows must get 10, or the
    // clamp would be silently inflating every small page into a 50-name disclosure.
    const listWorkers = vi.fn(async () => rows(10));
    const svc = service({ listWorkers } as never, permittedIdentity());
    await svc.listWorkers(admin(), { limit: 10 } as never, CTX);
    expect(listWorkers).toHaveBeenCalledWith(expect.anything(), null, 11);
  });

  it("the clamp is decided by the CAPABILITY, not by whether names came back", async () => {
    // A permitted admin who is over their egress budget gets `resolve() === null` — the same
    // value an analyst gets. The page size must still be the clamped one, because the decision
    // is about what the request was ENTITLED to ask for, and a size that depended on the cap
    // result would make an admin's page size flap as their budget drained.
    const listWorkers = vi.fn(async () => rows(60));
    const svc = service(
      { listWorkers } as never,
      permittedIdentity(vi.fn(async () => null) as never),
    );
    const page = await svc.listWorkers(admin(), { limit: 100 } as never, CTX);
    expect(listWorkers).toHaveBeenCalledWith(expect.anything(), null, 51);
    expect(page.items).toHaveLength(50);
    expect(page.items[0]).not.toHaveProperty("full_name");
  });

  it("DETAIL reads are untouched by the clamp — one row is one row", async () => {
    const findWorker = vi.fn(async () => ({ id: "w-1" }));
    const resolve = vi.fn(async () => new Map([["w-1", "Ramesh Kumar"]]));
    const svc = service({ findWorker } as never, permittedIdentity(resolve as never));
    await expect(svc.getWorker(admin(), "w-1", CTX)).resolves.toMatchObject({
      full_name: "Ramesh Kumar",
    });
  });

  it("job postings, applications and credits ask for NO names at all", async () => {
    // These three carry no person: `org_label` on a posting is poster-typed text already shown
    // to every worker in the feed, and the ledger is money. Resolving names for them would
    // spend budget and write audit rows for a disclosure that never happens.
    const resolve = vi.fn(async () => new Map());
    const svc = service({}, identityStub(resolve as never));
    await svc.listJobPostings({ limit: 5 } as never);
    await svc.listApplications({ limit: 5 } as never);
    await svc.getCredits("p-1", { limit: 5 } as never);
    expect(resolve).not.toHaveBeenCalled();
  });
});
