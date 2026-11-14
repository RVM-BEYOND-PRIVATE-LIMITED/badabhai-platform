import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import { INSTITUTE_STUDENT_STATUSES } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import {
  CAMPUS_SERVICE_TOKEN_HEADER,
  CampusExternalRefSchema,
  StudentRefSchema,
} from "./campus-link.contract";
import { isCanonicalUuid } from "../common/uuid";

/** Injection token for the `fetch` the client calls; tests substitute a stub. */
export const RVM_STUDENT_API_FETCH = Symbol("RVM_STUDENT_API_FETCH");

/**
 * The six fields RVM's Student API returns for a consenting student (Scheduler_Backend#162 item 7,
 * brief 4D.6), and nothing else: an extra key (a fee status, say) is a broken contract and the
 * read fails closed. Name and phone go straight to encrypted storage on `workers`.
 */
export const RvmStudentReadSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  /** Ten digits starting 6 to 9; normalised to +91 E.164 before it is hashed. */
  phone: z.string().regex(/^[6-9]\d{9}$/),
  course: z.string().trim().min(1).max(200),
  /** The branch (location) NAME, as the Student API returns it. */
  branch: z.string().trim().min(1).max(200),
  status: z.enum(INSTITUTE_STUDENT_STATUSES),
  /** The course average; null until RVM reports one. */
  test_score: z.number().min(0).max(100).nullable(),
});
export type RvmStudentRead = z.infer<typeof RvmStudentReadSchema>;

/**
 * `not_available` is RVM's one refusal for every reason (no consent, not linked, not active), by
 * design indistinguishable. Anything else that is not a valid read throws
 * {@link RvmStudentApiUnavailableError}.
 */
export type RvmStudentLookup =
  | { kind: "available"; student: RvmStudentRead }
  | { kind: "not_available" };

export type RvmStudentApiFailure =
  | "not_configured"
  | "timeout"
  | "network"
  | "http_status"
  | "contract";

/**
 * RVM could not give a usable answer. RETRYABLE from the caller's side, and never a refusal: a
 * caller must create nothing, and must NOT treat it as consent withdrawn, or an RVM outage (or a
 * wrong base URL) would unlink every student. Carries no body and no phone.
 */
export class RvmStudentApiUnavailableError extends Error {
  constructor(
    readonly failure: RvmStudentApiFailure,
    detail?: string,
  ) {
    super(`RVM Student API unavailable (${failure}${detail ? `: ${detail}` : ""})`);
    this.name = "RvmStudentApiUnavailableError";
  }
}

/**
 * A named-company consent request as RVM answers it (Scheduler_Backend#162 item 10, with the
 * company asked for on 14 Nov 2026). Open on unknown keys: it carries no personal data, only refs
 * and states. `company.ref` is BadaBhai's company id; until RVM returns it, no grant can be
 * bound to a company and every grant is refused.
 */
export const RvmConsentRequestSchema = z.object({
  request_id: z.string().min(1).max(200),
  company: z
    .object({ ref: z.string().max(64).refine(isCanonicalUuid, "must be a uuid") })
    .optional(),
  students: z
    .array(
      z.object({
        student_ref: z.string().min(1).max(128),
        state: z.enum(["pending", "yes", "no", "expired", "not_available"]),
      }),
    )
    .max(1_000),
});

/** What a consent read tells a grant: the company asked for, and each student's answer. */
export type RvmConsentLookup =
  | {
      kind: "found";
      /** Lower-cased; null when RVM did not say, which binds no grant. */
      companyRef: string | null;
      /** Lower-cased student ref → his answer. */
      answers: ReadonlyMap<
        string,
        z.infer<typeof RvmConsentRequestSchema>["students"][number]["state"]
      >;
    }
  | { kind: "not_available" };

const NotAvailableBodySchema = z.object({ code: z.literal("NOT_AVAILABLE") });

/** Six short fields fit in well under this; anything longer is not the agreed reply. */
const MAX_BODY_CHARS = 16_384;
/** A consent request lists up to a thousand short refs. */
const MAX_CONSENT_BODY_CHARS = 131_072;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads a student's agreed fields from RVM's Student API (#2752 item 7). Campus sends BadaBhai
 * only the student's reference; everything about him comes from here, under his RVM consent.
 *
 * NEVER LOGS A RESPONSE. The body carries his name and phone; errors carry a failure kind and,
 * for an HTTP failure, only the status code.
 */
@Injectable()
export class RvmStudentApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Optional() @Inject(RVM_STUDENT_API_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async readStudent(studentRef: string): Promise<RvmStudentLookup> {
    // Checked here as well as by callers: the ref goes into the URL path, and a value such as
    // `..` survives encodeURIComponent and would point the token at another route.
    const ref = StudentRefSchema.parse(studentRef);
    const reply = await this.get(
      `/internal/campus/students/${encodeURIComponent(ref)}`,
      MAX_BODY_CHARS,
    );
    if (reply.kind === "not_available") return reply;

    const parsed = RvmStudentReadSchema.safeParse(reply.body);
    if (!parsed.success) throw new RvmStudentApiUnavailableError("contract");
    return { kind: "available", student: parsed.data };
  }

  /**
   * Reads one named-company consent request and its answers (#2752 item 10). RVM's 404
   * `NOT_AVAILABLE` (an unknown request) is a refusal; anything else unusable throws
   * {@link RvmStudentApiUnavailableError}, never a "no".
   */
  async readConsentRequest(requestId: string): Promise<RvmConsentLookup> {
    const id = CampusExternalRefSchema.parse(requestId);
    const reply = await this.get(
      `/internal/campus/consent-requests/${encodeURIComponent(id)}`,
      MAX_CONSENT_BODY_CHARS,
    );
    if (reply.kind === "not_available") return reply;

    const parsed = RvmConsentRequestSchema.safeParse(reply.body);
    if (!parsed.success || parsed.data.request_id !== id) {
      throw new RvmStudentApiUnavailableError("contract");
    }
    return {
      kind: "found",
      companyRef: parsed.data.company?.ref.toLowerCase() ?? null,
      answers: new Map(parsed.data.students.map((s) => [s.student_ref.toLowerCase(), s.state])),
    };
  }

  /**
   * One GET to the Student API with the BadaBhai token. Only RVM's own 404 `NOT_AVAILABLE` is a
   * refusal; a bare 404 (a wrong base URL, a missing route) is an outage, never "withdrawn".
   */
  private async get(
    path: string,
    maxBodyChars: number,
  ): Promise<{ kind: "body"; body: unknown } | { kind: "not_available" }> {
    const base = this.config.RVM_STUDENT_API_BASE_URL;
    const token = this.config.RVM_STUDENT_API_TOKEN;
    if (!base || !token) throw new RvmStudentApiUnavailableError("not_configured");

    const url = `${base.replace(/\/+$/, "")}${path}`;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { [CAMPUS_SERVICE_TOKEN_HEADER]: token, accept: "application/json" },
        // Never follow a redirect: `X-Service-Token` would ride along to wherever it points.
        redirect: "error",
        signal: AbortSignal.timeout(this.config.RVM_STUDENT_API_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new RvmStudentApiUnavailableError(timedOut ? "timeout" : "network");
    }
    if (text.length > maxBodyChars) throw new RvmStudentApiUnavailableError("contract");

    const body = parseJson(text);
    if (res.status === 404) {
      if (NotAvailableBodySchema.safeParse(body).success) return { kind: "not_available" };
      throw new RvmStudentApiUnavailableError("http_status", "404");
    }
    if (res.status !== 200) {
      throw new RvmStudentApiUnavailableError("http_status", String(res.status));
    }
    return { kind: "body", body };
  }
}
