/**
 * The canonical 8-4-4-4-12 hex form — what a Postgres `uuid` column accepts, and the form
 * `pg` hands back for every id this codebase reads.
 *
 * WHY A SHARED HOME. This exact regex was written out three times independently
 * (`admin-feedback.service.ts`, `request-id.middleware.ts`, and a PII assertion helper) before
 * anything needed a fourth. Each copy is correct today and each is one careless edit from
 * disagreeing with the others about what an id is — which matters, because two of them decide
 * whether untrusted client input reaches a query.
 *
 * DELIBERATELY VERSION-AGNOSTIC. It checks the LAYOUT, not RFC 4122 versioning: the question
 * this answers is "will Postgres accept this at BIND", not "is this a well-formed v4". Ids in
 * this schema come from `gen_random_uuid()` (v4) today, but a v1, v7 or seeded uuid is a
 * perfectly valid value in a `uuid` column, and a version-strict check would reject real rows —
 * turning a validator into an outage. zod's `.uuid()` (3.25.x), which the DTOs use, accepts the
 * same set for the same reason; this exists for the paths that have no zod schema to hang off.
 *
 * SLIGHTLY STRICTER THAN POSTGRES, ON PURPOSE. Postgres also accepts un-dashed and
 * brace-wrapped forms. Nothing in this codebase ever emits those, so rejecting them costs
 * nothing and keeps "what an id looks like" to a single shape.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a canonical 8-4-4-4-12 hex uuid, in either case. */
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value);
}
