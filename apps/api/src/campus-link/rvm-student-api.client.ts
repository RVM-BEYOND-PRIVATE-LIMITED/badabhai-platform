import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import { INSTITUTE_STUDENT_STATUSES } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { CAMPUS_SERVICE_TOKEN_HEADER } from "./campus-link.contract";

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

const NotAvailableBodySchema = z.object({ code: z.literal("NOT_AVAILABLE") });

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
    const base = this.config.RVM_STUDENT_API_BASE_URL;
    const token = this.config.RVM_STUDENT_API_TOKEN;
    if (!base || !token) throw new RvmStudentApiUnavailableError("not_configured");

    const url = `${base.replace(/\/+$/, "")}/internal/campus/students/${encodeURIComponent(studentRef)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { [CAMPUS_SERVICE_TOKEN_HEADER]: token, accept: "application/json" },
        signal: AbortSignal.timeout(this.config.RVM_STUDENT_API_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new RvmStudentApiUnavailableError(timedOut ? "timeout" : "network");
    }

    const body = await res.json().catch(() => undefined);

    if (res.status === 404) {
      // Only RVM's own refusal counts as one. A bare 404 (a wrong base URL, a missing route)
      // must not read as "this student withdrew".
      if (NotAvailableBodySchema.safeParse(body).success) return { kind: "not_available" };
      throw new RvmStudentApiUnavailableError("http_status", "404");
    }
    if (res.status !== 200) {
      throw new RvmStudentApiUnavailableError("http_status", String(res.status));
    }

    const parsed = RvmStudentReadSchema.safeParse(body);
    if (!parsed.success) throw new RvmStudentApiUnavailableError("contract");
    return { kind: "available", student: parsed.data };
  }
}
