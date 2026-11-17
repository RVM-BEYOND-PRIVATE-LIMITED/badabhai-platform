import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { paymentOrders, workforceUuid } from "@badabhai/db";
import {
  countablePayer,
  countableWorker,
  excludeImportedOpens,
  excludeLinkedRvmIdentities,
  excludeSamplePayers,
  excludeSamplePostings,
  excludeSampleWorkers,
  excludeTestAndSampleWorkerRefs,
  excludeTestPayers,
  excludeTestWorkers,
  isCountableWorker,
  isSamplePayerId,
  isLinkedRvmIdentityAwaitingSignIn,
  isSampleWorkerId,
  isTestPayer,
  isTestWorker,
} from "./exclusions";

/**
 * #2755 item 2 — one function per exclusion rule. The SQL is proved against Postgres in
 * `admin-numbers.db.test.ts`; here, the predicates and the shape of each fragment.
 */

const dialect = new PgDialect();
const render = (s: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(s);

describe("companies — excludeTestPayers / isTestPayer", () => {
  it("is a NOT IN over the marked companies, the outer reference kept OUTSIDE the subquery", () => {
    const q = render(excludeTestPayers(sql.raw(`"payment_orders"."payer_id"`)));
    expect(q.sql).toBe(
      `("payment_orders"."payer_id" NOT IN (SELECT "tp"."id" FROM "payers" "tp" WHERE "tp"."is_test_account"))`,
    );
    expect(q.params).toEqual([]);
  });

  it("takes a Drizzle column as the outer reference", () => {
    const q = render(excludeTestPayers(paymentOrders.payerId));
    expect(q.sql).toMatch(/^\(.*"payer_id" NOT IN \(SELECT "tp"\."id" FROM "payers" "tp"/);
    // The outer column never appears inside the subquery, so it cannot bind to "tp".
    const inner = q.sql.slice(q.sql.indexOf("(SELECT"));
    expect(inner).not.toContain("payer_id");
  });

  it("the in-memory twin reads the column", () => {
    expect(isTestPayer({ isTestAccount: true })).toBe(true);
    expect(isTestPayer({ isTestAccount: false })).toBe(false);
  });
});

describe("workers — one rule each", () => {
  it("test accounts: workers.is_test_account", () => {
    expect(render(excludeTestWorkers).sql).toBe(`(NOT "workers"."is_test_account")`);
    expect(isTestWorker({ isTestAccount: true })).toBe(true);
    expect(isTestWorker({ isTestAccount: false })).toBe(false);
  });

  it("sample workers: both seeded cohorts' id patterns, bound as parameters", () => {
    const q = render(excludeSampleWorkers);
    expect(q.sql).toBe(`("workers"."id"::text NOT LIKE $1) AND ("workers"."id"::text NOT LIKE $2)`);
    expect(q.params).toEqual(["face2000-0000-4000-8000-%", "be162000-0000-4000-8000-%"]);
    expect(isSampleWorkerId(workforceUuid("worker", 3))).toBe(true);
    expect(isSampleWorkerId(randomUUID())).toBe(false);
  });

  it("linked RVM identities: the admin sign-up scope, reused (pending + institute origin)", () => {
    const q = render(excludeLinkedRvmIdentities).sql;
    expect(q).toContain(`"workers"."status" = 'pending'`);
    expect(q).toContain("o.kind = 'institute'");
    expect(q.startsWith("(NOT (")).toBe(true);
    expect(isLinkedRvmIdentityAwaitingSignIn({ status: "pending", hasInstituteOrigin: true })).toBe(
      true,
    );
    // A linked student who signed in, and a legacy pending row with no origin, both count.
    expect(isLinkedRvmIdentityAwaitingSignIn({ status: "active", hasInstituteOrigin: true })).toBe(
      false,
    );
    expect(
      isLinkedRvmIdentityAwaitingSignIn({ status: "pending", hasInstituteOrigin: false }),
    ).toBe(false);
  });

  it("countableWorker joins all three; isCountableWorker agrees", () => {
    const q = render(countableWorker);
    expect(q.sql).toContain(`NOT "workers"."is_test_account"`);
    expect(q.sql).toContain(`NOT LIKE`);
    expect(q.sql).toContain(`o.kind = 'institute'`);
    const real = {
      id: randomUUID(),
      isTestAccount: false,
      status: "active",
      hasInstituteOrigin: false,
    };
    expect(isCountableWorker(real)).toBe(true);
    expect(isCountableWorker({ ...real, isTestAccount: true })).toBe(false);
    expect(isCountableWorker({ ...real, id: workforceUuid("worker", 1) })).toBe(false);
    expect(isCountableWorker({ ...real, status: "pending", hasInstituteOrigin: true })).toBe(false);
    expect(isCountableWorker({ ...real, status: "active", hasInstituteOrigin: true })).toBe(true);
  });
});

describe("part B — sample companies and postings, worker references, imported opens", () => {
  it("sample companies: the workforce seed's payer pattern, bound as a parameter", () => {
    const q = render(excludeSamplePayers(sql.raw(`"payment_orders"."payer_id"`)));
    expect(q.sql).toBe(`("payment_orders"."payer_id"::text NOT LIKE $1)`);
    expect(q.params).toEqual(["face1000-0000-4000-8000-%"]);
    expect(isSamplePayerId(workforceUuid("payer", 4))).toBe(true);
    expect(isSamplePayerId(workforceUuid("payer", 4).toUpperCase())).toBe(true);
    expect(isSamplePayerId(workforceUuid("worker", 4))).toBe(false);
    expect(isSamplePayerId(randomUUID())).toBe(false);
  });

  it("countablePayer is the test rule AND the sample rule", () => {
    const q = render(countablePayer(sql.raw(`"hires"."tenant_payer_id"`)));
    expect(q.sql).toContain(
      `"hires"."tenant_payer_id" NOT IN (SELECT "tp"."id" FROM "payers" "tp"`,
    );
    expect(q.sql).toContain(`"hires"."tenant_payer_id"::text NOT LIKE $1`);
  });

  it("sample postings: the workforce seed's posting pattern", () => {
    const q = render(excludeSamplePostings(sql.raw(`"job_postings"."id"`)));
    expect(q.sql).toBe(`("job_postings"."id"::text NOT LIKE $1)`);
    expect(q.params).toEqual(["face3000-0000-4000-8000-%"]);
  });

  it("a worker reference keeps NULL (an erased worker) and drops test and sample workers", () => {
    const q = render(excludeTestAndSampleWorkerRefs(sql.raw(`"unlocks"."worker_id"`)));
    expect(q.sql.startsWith(`("unlocks"."worker_id" IS NULL OR (`)).toBe(true);
    expect(q.sql).toContain(
      `NOT IN (SELECT "tw"."id" FROM "workers" "tw" WHERE "tw"."is_test_account")`,
    );
    expect(q.params).toEqual(["face2000-0000-4000-8000-%", "be162000-0000-4000-8000-%"]);
  });

  it("the imported-opens hook keeps every open until #2754's import exists", () => {
    expect(render(excludeImportedOpens(sql.raw(`"unlocks"."id"`))).sql).toBe("TRUE");
  });
});
