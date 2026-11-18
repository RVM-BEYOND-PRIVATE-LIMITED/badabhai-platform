import { describe, expect, it } from "vitest";
import { RedactedQueryError } from "../common/db-error";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { CampusDriveRequestsRepository } from "./campus-drive-requests.repository";

/**
 * Security review M2 (#2746 PR 6): a failed statement must not carry the bound values out. A
 * drizzle query error puts every parameter in its own message (`Failed query: …\nparams: …`), and
 * `AllExceptionsFilter` logs `exception.stack` for every 5xx; the create binds the company's roles
 * note and the contact ciphertext, a decision binds the placement team's reason.
 */

const NOTE = "Need 12 CNC operators, Ravi Sharma will host the drive";
const REASON = "No campus slot this month, sorry Ravi";
const PHONE_CIPHER = "v1.c2VjcmV0.dGFn.Y2lwaGVy";

/**
 * A database handle every chain on which rejects, when awaited, the way drizzle does: with the bound
 * parameters inside the error's message. Any method chain (`insert().values()…`, `select()…for()`,
 * `update().set()…returning()`) ends at the same rejection.
 */
function dbThatFails(code: string) {
  const query = 'insert into "campus_drive_requests" (…) values ($1, $2, …) returning …';
  const params = ["tenant-uuid", NOTE, PHONE_CIPHER, REASON];
  const err = new Error(`Failed query: ${query}\nparams: ${params}`);
  Object.assign(err, { query, params, cause: { code } });
  const chain: unknown = new Proxy(function chainable() {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (_resolve: unknown, reject: (e: unknown) => void) => reject(err);
      }
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return chain as never;
}

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantKey;
const ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const STATEMENTS: [
  string,
  string,
  (repo: CampusDriveRequestsRepository, tx: never) => Promise<unknown>,
][] = [
  [
    "the create insert",
    "campus drive request insert",
    (repo, tx) =>
      repo.insert(tx, {
        payerId: TENANT,
        createdBy: TENANT,
        jobPostingId: null,
        branchIds: [],
        preferredFrom: "2026-12-01",
        preferredTo: "2026-12-02",
        openings: 1,
        rolesNote: NOTE,
        contactNameEnc: PHONE_CIPHER,
        contactPhoneEnc: PHONE_CIPHER,
        isTest: false,
        idempotencyKey: "key-0000001",
      }),
  ],
  [
    "the cancel lock",
    "campus drive request cancel lock",
    (repo, tx) => repo.lockOwn(tx, TENANT, ID),
  ],
  ["the cancel", "campus drive request cancel", (repo, tx) => repo.markCancelled(tx, ID)],
  [
    "the decision lock",
    "campus drive decision lock",
    (repo, tx) => repo.lockForDecision(tx, ID, "2026-11-20T05:00:00Z"),
  ],
  [
    "the decision write",
    "campus drive decision write",
    (repo, tx) =>
      repo.writeDecision(tx, ID, {
        status: "declined",
        previousStatus: "requested",
        scheduledOn: null,
        campusDriveRef: null,
        decidedAt: "2026-11-20T05:00:00Z",
        decidedByRef: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        decisionReason: REASON,
      }),
  ],
];

describe("CampusDriveRequestsRepository — a failed statement carries no bound value out", () => {
  it.each(STATEMENTS)("%s rethrows a RedactedQueryError", async (_name, operation, run) => {
    const db = dbThatFails("57014");
    const repo = new CampusDriveRequestsRepository(db);
    const err = await run(repo, db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedactedQueryError);
    const e = err as RedactedQueryError;
    for (const secret of [NOTE, REASON, PHONE_CIPHER, "Ravi"]) {
      expect(e.message).not.toContain(secret);
      expect(e.stack ?? "").not.toContain(secret);
    }
    // …while still saying what failed and why.
    expect(e.message).toContain(operation);
    expect(e.code).toBe("57014");
  });
});
