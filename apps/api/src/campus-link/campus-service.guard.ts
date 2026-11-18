import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { BlockList, isIPv4 } from "node:net";
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { isDevEnv, type ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { CampusCallAuditRepository, type CampusCallOutcome } from "./campus-call-audit.repository";
import { CAMPUS_CALL_ID_HEADER, CAMPUS_SERVICE_TOKEN_HEADER } from "./campus-link.contract";

/** The rate-limit namespaces and subject: there is exactly one Campus caller. */
const RATE_LIMIT_SCOPE = "campus_service";
const REFUSED_AUDIT_SCOPE = "campus_service_refused";
const CAMPUS_CALLER = "campus";

/**
 * Refused calls audited per UTC minute. Past it a refusal is still a refusal but writes no row, so
 * a caller looping on a stale token (or anything that can claim the Campus address) cannot turn
 * refusals into unbounded `audit_logs` inserts.
 */
const REFUSED_AUDIT_MAX_PER_MINUTE = 60;

/** Longer than any real token; bounds the hashing work an anonymous header can ask for. */
const MAX_TOKEN_LENGTH = 512;

/** One refused-address warning per this many ms, however many arrive: the log is not a firehose. */
const REFUSAL_LOG_INTERVAL_MS = 60_000;

/**
 * Addresses that are never Campus outside development. Campus calls from another host over the
 * internet, so `req.ip` must be its public address. A loopback, private or link-local `req.ip` in
 * production means the proxy hop is not trusted (`TRUST_PROXY_HOP_COUNT` 0): every caller would
 * then present the proxy's own address, and allow-listing it would admit the whole internet.
 */
const NEVER_CAMPUS_OUTSIDE_DEV = (() => {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addAddress("0.0.0.0", "ipv4");
  list.addAddress("::1", "ipv6");
  list.addAddress("::", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  return list;
})();

/**
 * Service-to-service auth for BadaBhai Campus, and nothing else (#2752 item 2, plan 4.2).
 *
 * ITS OWN CREDENTIAL. Campus never holds INTERNAL_SERVICE_TOKEN, which opens 17 ops controllers
 * that return personal data, and this guard never accepts it. Same least-privilege reasoning as
 * `SkillsInternalGuard`.
 *
 * IN ORDER, cheapest refusal first:
 *   1. `CAMPUS_LINK_ENABLED` off → the same 404 Nest gives a route that does not exist. Nothing is
 *      written.
 *   2. `req.ip` not on `CAMPUS_SERVICE_ALLOWED_IPS`, or (outside development) not a public address
 *      → 403. Logged with the address, at most once a minute (that line is how the real egress
 *      address of the Campus server is found at set-up), never written to the database.
 *   3. `X-Service-Token` whose sha256 matches none of `CAMPUS_SERVICE_TOKEN_SHA256S` → 401.
 *   4. Over `CAMPUS_SERVICE_MAX_PER_MINUTE` → 429.
 * Every accepted call writes one `audit_logs` row; refusals at steps 3 and 4 do too, up to
 * {@link REFUSED_AUDIT_MAX_PER_MINUTE}. If an accepted call's row cannot be written the call fails:
 * an unaudited call does not proceed.
 *
 * FAIL CLOSED. An empty allow-list refuses every address; no configured hash refuses every token.
 */
/**
 * The route as declared (`/internal/campus/v1/students/:student_ref`), never the concrete path.
 * An audit row outlives an unlink and a DPDP erasure, so it must not keep a student's, an
 * application's or a grant's reference (#2752 part C review). `req.route` is the layer Express
 * matched, set before a guard runs; "(unmatched)" if it is ever absent, never the raw path.
 */
export function routeTemplate(req: Pick<Request, "route">): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : "(unmatched)";
}

@Injectable()
export class CampusServiceGuard implements CanActivate {
  private readonly logger = new Logger(CampusServiceGuard.name);
  private readonly allowed: BlockList;
  private readonly requirePublicPeer: boolean;
  private lastRefusalLogAt = 0;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly audit: CampusCallAuditRepository,
    private readonly rateLimit: SubjectRateLimit,
  ) {
    this.allowed = new BlockList();
    for (const address of config.CAMPUS_SERVICE_ALLOWED_IPS) {
      this.allowed.addAddress(address, isIPv4(address) ? "ipv4" : "ipv6");
    }
    this.requirePublicPeer = !isDevEnv(config.NODE_ENV);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();

    if (!this.config.CAMPUS_LINK_ENABLED) {
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }

    const address = normaliseAddress(req.ip);
    if (address === null || !this.isAllowedPeer(address)) {
      this.logRefusedAddress(address);
      throw new ForbiddenException({ code: "ADDRESS_NOT_ALLOWED" });
    }

    const callId = randomUUID();
    const record = (outcome: CampusCallOutcome, tokenSlot: number | null) =>
      this.audit.record({
        callId,
        outcome,
        method: req.method,
        path: routeTemplate(req),
        handler: `${context.getClass().name}.${context.getHandler().name}`,
        tokenSlot,
      });

    const tokenSlot = matchTokenSlot(
      req.headers[CAMPUS_SERVICE_TOKEN_HEADER],
      this.config.CAMPUS_SERVICE_TOKEN_SHA256S,
    );
    if (tokenSlot === null) {
      if (this.config.CAMPUS_SERVICE_TOKEN_SHA256S.length === 0) {
        this.logger.warn("campus call refused: CAMPUS_SERVICE_TOKEN_SHA256S is not configured");
      }
      await this.recordRefusal(() => record("refused_token", null));
      throw new UnauthorizedException({ code: "UNAUTHENTICATED" });
    }

    try {
      await this.rateLimit.assertWithinMinuteCap(
        RATE_LIMIT_SCOPE,
        CAMPUS_CALLER,
        this.config.CAMPUS_SERVICE_MAX_PER_MINUTE,
      );
    } catch (err) {
      if (!(err instanceof HttpException) || err.getStatus() !== HttpStatus.TOO_MANY_REQUESTS) {
        throw err;
      }
      await this.recordRefusal(() => record("rate_limited", tokenSlot));
      throw new HttpException({ code: "RATE_LIMITED" }, HttpStatus.TOO_MANY_REQUESTS);
    }

    await record("accepted", tokenSlot);
    http.getResponse<Response>().setHeader(CAMPUS_CALL_ID_HEADER, callId);
    return true;
  }

  private isAllowedPeer(address: string): boolean {
    const family = isIPv4(address) ? "ipv4" : "ipv6";
    if (this.requirePublicPeer && NEVER_CAMPUS_OUTSIDE_DEV.check(address, family)) return false;
    return this.allowed.check(address, family);
  }

  /** Audits a refusal while under its own per-minute budget; past it, refuses without a row. */
  private async recordRefusal(write: () => Promise<void>): Promise<void> {
    try {
      await this.rateLimit.assertWithinMinuteCap(
        REFUSED_AUDIT_SCOPE,
        CAMPUS_CALLER,
        REFUSED_AUDIT_MAX_PER_MINUTE,
      );
    } catch {
      return;
    }
    await write();
  }

  private logRefusedAddress(address: string | null): void {
    const now = Date.now();
    if (now - this.lastRefusalLogAt < REFUSAL_LOG_INTERVAL_MS) return;
    this.lastRefusalLogAt = now;
    this.logger.warn(`campus call refused: address ${address ?? "unknown"} is not allowed`);
  }
}

/** `req.ip` as configured addresses are written: an IPv4 peer arrives as `::ffff:a.b.c.d`. */
export function normaliseAddress(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice("::ffff:".length) : ip;
}

/**
 * The index of the configured hash the presented token matches, or null.
 *
 * Every configured hash is compared, with no early exit, and every comparison is between two
 * 32-byte digests, so neither the token's length nor which slot matched shows in the timing.
 */
export function matchTokenSlot(raw: unknown, sha256Hexes: readonly string[]): number | null {
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (typeof provided !== "string" || provided.length === 0 || provided.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const digest = createHash("sha256").update(provided, "utf8").digest();
  let slot: number | null = null;
  for (const [index, hex] of sha256Hexes.entries()) {
    const matches = timingSafeEqual(digest, Buffer.from(hex, "hex"));
    if (matches && slot === null) slot = index;
  }
  return slot;
}
