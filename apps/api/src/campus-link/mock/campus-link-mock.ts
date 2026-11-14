import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  CAMPUS_IDEMPOTENCY_KEY_HEADER,
  CAMPUS_LINK_BASE_PATH,
  CAMPUS_SERVICE_TOKEN_HEADER,
  CampusApplicationsQuerySchema,
  CampusApplyBodySchema,
  CampusCompanyQuerySchema,
  CampusExternalRefSchema,
  CampusIdempotencyKeySchema,
  CampusPostForCompanyBodySchema,
  CampusPostingsQuerySchema,
  CampusReviewBodySchema,
  CampusSearchGrantBodySchema,
  CampusTargetingOptionsBodySchema,
  StudentRefSchema,
  type CampusErrorCode,
} from "../campus-link.contract";
import * as examples from "../campus-link.examples";

/**
 * A stand-in for BadaBhai's Campus API (#2752 item 1, "a mock"), so Campus can build its client
 * before the real routes exist. Same paths, headers, schemas and error envelope as the contract;
 * the data is the published examples plus whatever Campus applies or grants, held in memory.
 *
 * It checks the token by plain equality and has no allow-list, flag, cap or audit row: those are
 * the real guard's job and are proved in `campus-service.guard.test.ts`. No database, no Redis.
 */

export interface MockRequest {
  method: string;
  /** Path and query, e.g. `/internal/campus/v1/job-postings?limit=5`. */
  url: string;
  headers: Record<string, string | undefined>;
  /** The raw body, or undefined when none was sent. */
  body: string | undefined;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

type Application = z.input<typeof CampusApplyBodySchema> & {
  application_id: string;
  stage: "new" | "withdrawn";
  changed_at: string;
};

const BASE = `/${CAMPUS_LINK_BASE_PATH}/`;
const KNOWN_POSTING_ID = examples.POSTING_EXAMPLE.id;
const KNOWN_COMPANY_PHONE = examples.POST_FOR_COMPANY_BODY_EXAMPLE.company.phone;

export function createCampusLinkMock(options: { token: string }) {
  const applications = new Map<string, Application>();
  const grants = new Map<
    string,
    z.output<typeof CampusSearchGrantBodySchema> & {
      state: "active" | "revoked";
      changed_at: string;
    }
  >();

  /** The newest decision / list held, by Campus's own time, and what it was. */
  let review: { at: number; fingerprint: string; state: string } | null = null;
  let targeting: { at: number; fingerprint: string } | null = null;

  return function handle(req: MockRequest): MockResponse {
    const url = new URL(req.url, "http://mock");
    if (!url.pathname.startsWith(BASE)) return notFound(url.pathname);
    if (req.headers[CAMPUS_SERVICE_TOKEN_HEADER] !== options.token) {
      return error(401, "UNAUTHENTICATED", url.pathname);
    }

    const method = req.method.toUpperCase();
    if (method !== "GET") {
      const key = req.headers[CAMPUS_IDEMPOTENCY_KEY_HEADER];
      if (!key || !CampusIdempotencyKeySchema.safeParse(key).success) {
        return error(400, "IDEMPOTENCY_KEY_REQUIRED", url.pathname);
      }
    }

    let segments: string[];
    try {
      segments = url.pathname.slice(BASE.length).split("/").map(decodeURIComponent);
    } catch {
      return notFound(url.pathname);
    }
    const query = Object.fromEntries(url.searchParams);
    const route = routeKey(method, segments);
    const now = new Date().toISOString();

    switch (route) {
      case "GET ping":
        return ok({ ok: true, call_id: randomUUID() });

      case "GET job-postings": {
        const q = CampusPostingsQuerySchema.safeParse(query);
        if (!q.success) return invalid(url.pathname, q.error);
        const p = examples.POSTING_EXAMPLE;
        const matches =
          (!q.data.review_state || q.data.review_state === p.review_state) &&
          (q.data.branch_id === undefined ||
            p.branch_ids.length === 0 ||
            p.branch_ids.includes(q.data.branch_id)) &&
          (!q.data.course_id ||
            p.courses.length === 0 ||
            p.courses.some((c) => c.id === q.data.course_id));
        return ok({ postings: matches ? [p] : [], next_cursor: null });
      }

      case "PUT job-postings/:id/review": {
        const body = parseBody(req.body, CampusReviewBodySchema, url.pathname);
        if ("status" in body) return body;
        if (segments[1] !== KNOWN_POSTING_ID) return notFound(url.pathname);
        const { decided_at, ...decision } = body.data;
        const at = Date.parse(decided_at);
        const fingerprint = JSON.stringify({
          ...decision,
          branch_ids: [...(decision.branch_ids ?? [])].sort(),
          course_ids: [...(decision.course_ids ?? [])].sort(),
        });
        const answer = { posting_id: KNOWN_POSTING_ID, reviewed_at: decided_at };
        // The real route's order: time first, then the content hash.
        if (review !== null && at <= review.at) {
          return at === review.at && fingerprint === review.fingerprint
            ? ok({ ...answer, review_state: review.state })
            : error(409, "DECISION_SUPERSEDED", url.pathname);
        }
        // The posting "changed" unless the body echoes the hash the example feed shows.
        if (decision.content_hash !== examples.POSTING_EXAMPLE.content_hash) {
          return error(409, "POSTING_CHANGED", url.pathname);
        }
        review = { at, fingerprint, state: decision.state };
        return ok({ ...answer, review_state: decision.state });
      }

      case "PUT targeting-options": {
        const body = parseBody(req.body, CampusTargetingOptionsBodySchema, url.pathname);
        if ("status" in body) return body;
        const { as_of, ...list } = body.data;
        const at = Date.parse(as_of);
        const fingerprint = JSON.stringify(list);
        if (targeting !== null && at <= targeting.at && fingerprint !== targeting.fingerprint) {
          return error(409, "DECISION_SUPERSEDED", url.pathname);
        }
        if (targeting === null || at > targeting.at) targeting = { at, fingerprint };
        // No stored rows here: every option reads as new, and nothing is retired.
        const counts = (listed: number) => ({ listed, added: listed, updated: 0, deactivated: 0 });
        return ok({
          branches: counts(body.data.branches.length),
          courses: counts(body.data.courses.length),
        });
      }

      case "POST job-postings": {
        const body = parseBody(req.body, CampusPostForCompanyBodySchema, url.pathname);
        if ("status" in body) return body;
        const known = body.data.company.phone === KNOWN_COMPANY_PHONE;
        return {
          status: 201,
          body: {
            ...examples.POST_FOR_COMPANY_RESPONSE_EXAMPLE,
            posting_id: randomUUID(),
            company_id: known ? examples.COMPANY_RESPONSE_EXAMPLE.company?.id : randomUUID(),
            company_created: !known,
          },
        };
      }

      case "GET companies": {
        const q = CampusCompanyQuerySchema.safeParse(query);
        if (!q.success) return invalid(url.pathname, q.error);
        return ok(
          q.data.phone === KNOWN_COMPANY_PHONE
            ? examples.COMPANY_RESPONSE_EXAMPLE
            : { company: null },
        );
      }

      case "POST applications": {
        const body = parseBody(req.body, CampusApplyBodySchema, url.pathname);
        if ("status" in body) return body;
        const existing = applications.get(body.data.external_ref);
        if (existing) {
          const same =
            existing.posting_id === body.data.posting_id &&
            existing.student_ref === body.data.student_ref;
          return same
            ? ok(toApplication(existing))
            : error(409, "EXTERNAL_REF_CONFLICT", url.pathname);
        }
        if (body.data.posting_id !== KNOWN_POSTING_ID) return notFound(url.pathname);
        const created: Application = {
          ...body.data,
          application_id: randomUUID(),
          stage: "new",
          changed_at: now,
        };
        applications.set(created.external_ref, created);
        return { status: 201, body: toApplication(created) };
      }

      case "GET applications": {
        const q = CampusApplicationsQuerySchema.safeParse(query);
        if (!q.success) return invalid(url.pathname, q.error);
        const since = q.data.changed_since ? Date.parse(q.data.changed_since) : -Infinity;
        const page = [...applications.values()]
          .filter((a) => Date.parse(a.changed_at) >= since)
          .slice(0, q.data.limit)
          .map(toApplication);
        return ok({ applications: page, next_cursor: null });
      }

      case "DELETE applications/:id": {
        const app = applications.get(segments[1] ?? "");
        if (!app) return notFound(url.pathname);
        if (app.stage !== "withdrawn") {
          app.stage = "withdrawn";
          app.changed_at = now;
        }
        return ok(toApplication(app));
      }

      case "PUT search-grants/:id": {
        const ref = CampusExternalRefSchema.safeParse(segments[1]);
        if (!ref.success) return invalid(url.pathname, ref.error);
        const body = parseBody(req.body, CampusSearchGrantBodySchema, url.pathname);
        if ("status" in body) return body;
        grants.set(ref.data, { ...body.data, state: "active", changed_at: now });
        return ok({ grant_ref: ref.data, ...body.data, state: "active", changed_at: now });
      }

      case "DELETE search-grants/:id": {
        const grant = grants.get(segments[1] ?? "");
        if (!grant) return notFound(url.pathname);
        if (grant.state !== "revoked") {
          grant.state = "revoked";
          grant.changed_at = now;
        }
        return ok({ grant_ref: segments[1], ...grant });
      }

      case "DELETE students/:id": {
        const ref = StudentRefSchema.safeParse(segments[1]);
        if (!ref.success) return invalid(url.pathname, ref.error);
        return ok({ student_ref: ref.data, state: "unlinked" });
      }

      default:
        return notFound(url.pathname);
    }
  };
}

/** `GET job-postings`, `PUT job-postings/:id/review`, `DELETE applications/:id`; null past three parts. */
function routeKey(method: string, segments: string[]): string | null {
  const [resource, id, action] = segments;
  if (!resource || segments.length > 3) return null;
  return [`${method} ${resource}`, id === undefined ? null : ":id", action ?? null]
    .filter((part) => part !== null)
    .join("/");
}

function toApplication(a: Application) {
  return {
    application_id: a.application_id,
    external_ref: a.external_ref,
    posting_id: a.posting_id,
    student_ref: a.student_ref,
    stage: a.stage,
    changed_at: a.changed_at,
  };
}

function parseBody<T extends z.ZodType>(
  raw: string | undefined,
  schema: T,
  path: string,
): { data: z.output<T> } | MockResponse {
  let json: unknown;
  try {
    json = raw === undefined || raw === "" ? undefined : JSON.parse(raw);
  } catch {
    return error(400, "VALIDATION_FAILED", path, "body is not JSON");
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { data: parsed.data } : invalid(path, parsed.error);
}

function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

function invalid(path: string, err: z.ZodError): MockResponse {
  return error(
    400,
    "VALIDATION_FAILED",
    path,
    err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  );
}

function notFound(path: string): MockResponse {
  return envelope(404, { message: "Not Found" }, path);
}

function error(
  status: number,
  code: CampusErrorCode,
  path: string,
  message?: unknown,
): MockResponse {
  return envelope(status, message === undefined ? { code } : { code, message }, path);
}

function envelope(status: number, error: unknown, path: string): MockResponse {
  return {
    status,
    body: { statusCode: status, error, path, timestamp: new Date().toISOString() },
  };
}
