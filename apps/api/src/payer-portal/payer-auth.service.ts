import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PayerLoginMethodEnum } from "@badabhai/event-schema";
import { isE164Phone, emailSchema } from "@badabhai/validators";
import { SERVER_CONFIG } from "../config/config.module";
import { isSyntheticPayerEmail } from "../payers/payer-test-login.guard";
import { PiiCryptoService } from "../common/pii-crypto.service";
// #2497's never-matching scrypt token — now shared with the admin password door (0144).
import { DUMMY_PASSWORD_HASH } from "../common/password-policy";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayersRepository, CURRENT_PASSWORD_PEPPER_VERSION } from "../payers/payers.repository";
import { PayerOrgsRepository, type ResolvedOrg } from "../payers/payer-orgs.repository";
import { PayerSessionService } from "../payers/payer-session.service";
import { payerPasswordAttemptsKey } from "../payers/payer-password-lockout";
import { PayerSecurityNoticeService } from "../payers/payer-security-notice.service";
import { resolveSessionOrgClaim } from "../payers/payer-session-org-claim";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { PayerOtpService, type PayerOtpIssued } from "../payers/payer-otp.service";
import { FreeTierService } from "../match/free-tier.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import type {
  PayerSignupDto,
  PayerLoginRequestDto,
  PayerLoginVerifyDto,
  PayerAuthCodeResponse,
  PayerSessionResponse,
  PayerRefreshResponse,
  PayerPasswordChangeRequiredResponse,
} from "./payer-auth.dto";

/**
 * The supplied OTP contact (#2497 — email and/or phone; at least one, enforced by the
 * DTOs). EMAIL WINS when both are supplied: signup stays keyed on the email hash
 * (preserving the pre-#2497 dedup), and request/verify MUST carry the same contact in
 * both calls, so the rule has to be deterministic AND identical everywhere.
 */
type PayerLoginContact = { kind: "email"; value: string } | { kind: "phone"; value: string };

/** Minimal typed view of the raw Redis commands the password lockout needs. */
interface RedisPasswordClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Self-serve PAYER auth orchestration (ADR-0019 Decision B — closes R16/LC-1/TD33). The
 * payer analogue of {@link import("../auth/auth.service").AuthService}, for the THIRD
 * principal. Signup create-or-gets the account (emitting `payer.created` once), then a
 * code is issued over the config-selected {@link PayerOtpService} channel; verify mints a
 * revocable {@link PayerSessionService} session and emits `payer.session_started`.
 *
 * XB-H (no user-enumeration): signup and login-request return a DELIBERATELY identical,
 * account-state-INDEPENDENT response. A login-request for an UNKNOWN email still runs the
 * identical OTP reserve (cooldown/cap/store) via {@link PayerOtpService.issueWithoutDelivery}
 * so its timing/response matches a known one; a delivery failure (which only occurs for a
 * KNOWN account) is swallowed to the same neutral body; and verify mints a session ONLY for
 * a real account, returning the SAME "incorrect or expired" 401 otherwise.
 *
 * PRIVACY (B-R2): the raw email/phone/org-name are accepted, encrypted at rest in `payers`,
 * and NEVER logged or put in an event — only the opaque `payer_id` + role/method enums.
 */
@Injectable()
export class PayerAuthService {
  private readonly logger = new Logger(PayerAuthService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly payers: PayersRepository,
    private readonly orgs: PayerOrgsRepository,
    private readonly otp: PayerOtpService,
    private readonly sessions: PayerSessionService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    // ADR-0036 §8 — the free-tier credit grant. MatchModule is @Global.
    private readonly freeTier: FreeTierService,
    // ADR-0053 — the ONE acting-org choice (session claim + login), shared with the guards.
    private readonly tenancy: PayerTenantScopeService,
    // Password-attempt lockout counter (per payer id) — reuse BullMQ's existing Redis
    // connection, do NOT add a second client (same rule as IpRateLimit / PayerOtpService).
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
    // #2563 — the credential-change security notice (best-effort, after commit).
    private readonly notice: PayerSecurityNoticeService,
  ) {}

  private get method(): PayerLoginMethodEnum {
    return this.config.PAYER_LOGIN_METHOD;
  }

  /** POST /payer/signup — create-or-get the account, emit `payer.created` (once), issue a code. */
  async signup(dto: PayerSignupDto, ctx: RequestContext): Promise<PayerAuthCodeResponse> {
    const { id, created } = await this.payers.createOrGet({
      role: dto.role,
      email: dto.email,
      orgName: dto.org_name,
      phone: dto.phone,
    });

    if (created) {
      await this.events.emit({
        event_name: "payer.created",
        actor: { actor_type: "payer", actor_id: id },
        subject: { subject_type: "payer", subject_id: id },
        payload: { payer_id: id, role: dto.role, method: this.method },
        idempotencyKey: `payer.created:${id}`, // once-only per account
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      // Every new payer founds a SOLO org with themselves as OWNER (ADR-0027 / B5). Idempotent
      // + only on the created path — an existing account is never mutated here (XB-H). The org's
      // own `org.created` audit event ships with the member lifecycle in B5.3; today the org is a
      // deterministic 1:1 consequence of `payer.created` (which is evented above).
      await this.orgs.ensureSoloOrg(id);
      // ADR-0036 §8 — the FREE TIER. A new payer starts with
      // `match_config.free_unlock_credits` unlock credits, so they can see whether the
      // supply is real before being asked for money.
      //
      // Only on the `created` path, and idempotent regardless: the grant is keyed
      // `free_tier_grant:<payerId>` and the existing `credit_ledger_idempotency_key_uq`
      // makes it exactly-once, so a retried signup and the D6 backfill converge on one
      // grant. `grantQuietly` swallows + logs — a payer whose ACCOUNT was created must
      // not get a 500 because a credit grant hiccuped, and the grant is repairable by
      // re-running `db:grant:free-tier` while the signup is not.
      await this.freeTier.grantQuietly(id);
    }

    // Issue a code to the canonical stored contact (uniform for new + existing — no
    // overwrite of an existing account; the response is identical either way, XB-H).
    // The contact is whichever the caller supplied (email wins on a both-supplied body).
    try {
      const issued = await this.issueForExistingAccount(
        id,
        { email: dto.email, phone: dto.phone },
        ctx,
        false,
      );
      return this.codeResponse(issued);
    } catch (err) {
      return this.neutralOnSendCapBreach(err, ctx);
    }
  }

  /** POST /payer/login/request — issue a code; NO-ENUMERATION across known/unknown contacts. */
  async requestLogin(
    dto: PayerLoginRequestDto,
    ctx: RequestContext,
  ): Promise<PayerAuthCodeResponse> {
    try {
      const contact = PayerAuthService.mustContact(dto);
      const account = await this.findByContact(contact);
      let issued: PayerOtpIssued;
      if (account) {
        issued = await this.issueForExistingAccount(
          account.id,
          { email: dto.email, phone: dto.phone },
          ctx,
          true,
        );
      } else {
        // UNKNOWN contact: run the IDENTICAL reserve (cooldown/cap/store) WITHOUT delivery so
        // the observable timing/response + 429s match a known account. No event is emitted
        // (no subject), and that asymmetry is not caller-observable (the body is identical).
        issued = await this.otp.issueWithoutDelivery(this.contactHash(contact));
      }
      return this.codeResponse(issued);
    } catch (err) {
      return this.neutralOnSendCapBreach(err, ctx);
    }
  }

  /**
   * POST /payer/test-login — mint a payer session WITHOUT an OTP round-trip (Phase 2.1).
   *
   * Reachable only behind {@link PayerTestLoginGuard} (env gate + server secret) and only for an
   * address inside the reserved `.invalid` domain. Staging runs a real email provider, so real
   * payer accounts exist there; without the domain restriction one leaked gate token would mean
   * full impersonation of a real customer. A non-synthetic address gets the SAME neutral 404 the
   * guard returns while disabled, so a token holder cannot distinguish "seam off" from "address
   * not allowed" — no oracle either way. The refusal is logged WITHOUT the address (PII).
   *
   * It reuses the ordinary account path (`createOrGet` + `ensureSoloOrg`), so a test session
   * authenticates and resolves its org exactly like a real one. Two DELIBERATE differences:
   * no mailbox was proven — which is precisely what `payer.test_login` records on the spine —
   * and the account is force-`activate`d rather than promoted by a first successful verify.
   *
   * ⚠ NO FREE-TIER GRANT. Unlike {@link signup}, this path does NOT call
   * `freeTier.grantQuietly`, so a test-minted payer starts with ZERO unlock credits — never
   * assume `match_config.free_unlock_credits` is already on the ledger here. A test that needs
   * credits must seed them explicitly (`payer-tenancy.e2e.test.ts` does this via the ops route).
   * Whether the seam SHOULD mirror the grant is a product call, not a drift to be silently
   * closed; `payer-auth.service.test.ts` locks today's answer so the two cannot diverge unnoticed.
   */
  async testLogin(email: string, ctx: RequestContext): Promise<PayerSessionResponse> {
    if (!isSyntheticPayerEmail(email)) {
      this.logger.warn("payer test login refused: address outside the reserved synthetic domain");
      throw new NotFoundException("Not found");
    }

    const { id, created } = await this.payers.createOrGet({
      role: "employer",
      email,
      orgName: "E2E Test Org",
      phone: undefined,
    });

    if (created) {
      await this.events.emit({
        event_name: "payer.created",
        actor: { actor_type: "payer", actor_id: id },
        subject: { subject_type: "payer", subject_id: id },
        payload: { payer_id: id, role: "employer", method: this.method },
        idempotencyKey: `payer.created:${id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }
    const org = await this.resolveOrEnsureOrg(id);
    // A synthetic account must be `active` or PayerAuthGuard 403s it on the very next request.
    await this.payers.activate(id);

    // #2079 — the org claim rides the session exactly as on a real login.
    const session = await this.sessions.create(id, "employer", org);
    await this.recordLogin(id);

    // NOT `payer.session_started`: a synthetic session must never be indistinguishable from a
    // real login when reading the spine. No idempotencyKey — each mint is a distinct fact.
    await this.events.emit({
      event_name: "payer.test_login",
      actor: { actor_type: "payer", actor_id: id },
      subject: { subject_type: "payer", subject_id: id },
      payload: { payer_id: id, is_new_payer: created },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    this.logger.log("payer test login minted");

    return {
      access_token: session.token,
      token_type: "Bearer",
      expires_in_seconds: session.expiresInSeconds,
      payer_id: id,
      role: "employer",
      is_new_payer: created,
    };
  }

  /** POST /payer/login/verify — verify the code then mint a session (only for a real account). */
  async verifyLogin(dto: PayerLoginVerifyDto, ctx: RequestContext): Promise<PayerSessionResponse> {
    // The OTP key is the keyed hash of the SAME contact the request carried (#2497).
    const contact = PayerAuthService.mustContact(dto);
    // Verify FIRST (single message on failure — no enumeration, constant-time, single-use).
    await this.otp.verify(this.contactHash(contact), dto.code);

    // A reserved code for an UNKNOWN contact (issued for timing parity) can verify, but a
    // session is minted ONLY for a real account — otherwise return the SAME 401 (no oracle).
    const account = await this.findByContact(contact);
    if (!account) throw new UnauthorizedException("Incorrect or expired code");

    // Guarantee the payer's solo org + owner membership (ADR-0027 / B5). Cheap common case
    // (1 read → org already exists via signup or the B5.1 backfill); only a gap payer created
    // BEFORE B5.2 shipped has none, and is repaired here on first login. Idempotent, fail-safe.
    const org = await this.resolveOrEnsureOrg(account.id);

    // ADR-0037 — a SUSPENDED payer proves mailbox control but gets no session.
    //
    // The 403 is deliberately DISTINCT from the 401 an unknown/expired code returns, and
    // that costs no enumeration: to reach this line the caller has already presented a
    // valid single-use code for a real account, so they have proven both that the account
    // exists and that they control its mailbox. There is no oracle left to protect — and
    // TD110 records what the alternative costs: payer login was down end-to-end and stayed
    // invisible precisely because the client collapses every verify failure into one
    // neutral message. A suspended payer must be able to learn WHY.
    if (account.status === "suspended") {
      throw new ForbiddenException("Account is suspended");
    }

    // #2563 — a TEMPORARY password must be replaced before any session is issued, and the
    // code door must not bypass that. The caller has already proven the mailbox, so a distinct
    // 409 is not an enumeration oracle; it is the only way the client can tell the payer what
    // to do. No session is minted and no login is recorded.
    if (account.mustChangePassword) {
      throw new ConflictException("Password change required");
    }

    // First successful verification promotes the payer to `active`. The pending→active
    // predicate lives in the WHERE clause (see PayersRepository.activate), so this is
    // idempotent on every later login and structurally cannot resurrect a suspended row.
    // The event fires ONLY on the transition, so it marks first-verification exactly once.
    if (await this.payers.activate(account.id)) {
      await this.events.emit({
        event_name: "payer.activated",
        actor: { actor_type: "payer", actor_id: account.id },
        subject: { subject_type: "payer", subject_id: account.id },
        payload: { payer_id: account.id, previous_status: "pending", new_status: "active" },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    // Carry the role onto the session (ADR-0022) so PayerRoleGuard gates agent-only routes
    // without a DB hit; pre-ADR-0022 sessions (no role) resolve it via the guard's fallback.
    // #2079 — the member's `org_id`/`org_role` (just resolved from `payer_members`, never a
    // client value) rides the session as a display hint. The authority stays server-side:
    // PayerOrgRoleGuard re-reads the CURRENT role on every owner-only request.
    const session = await this.sessions.create(account.id, account.role, org);
    await this.recordLogin(account.id);
    await this.events.emit({
      event_name: "payer.session_started",
      actor: { actor_type: "payer", actor_id: account.id },
      subject: { subject_type: "payer", subject_id: account.id },
      payload: { payer_id: account.id, method: this.method, is_new_payer: false },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      access_token: session.token,
      token_type: "Bearer",
      expires_in_seconds: session.expiresInSeconds,
      payer_id: account.id,
      role: account.role,
      is_new_payer: false,
    };
  }

  /**
   * POST /payer/refresh — mint a fresh JWT for the already-validated payer+session. The #2079
   * org claim is RE-DECIDED from the current membership (never copied from the old token), so
   * a refresh after a demotion/removal drops the stale `owner` hint.
   */
  async refresh(payerId: string, sid: string): Promise<PayerRefreshResponse> {
    const org = await resolveSessionOrgClaim(this.tenancy, payerId);
    const fresh = await this.sessions.mint(payerId, sid, undefined, org);
    return {
      access_token: fresh.token,
      token_type: "Bearer",
      expires_in_seconds: fresh.expiresInSeconds,
    };
  }

  /** POST /payer/logout — revoke the current session. */
  async logout(sid: string): Promise<void> {
    await this.sessions.revoke(sid);
  }

  // ---------------------------------------------------------------------------

  /**
   * The payer's CURRENT acting org (ADR-0053 §3.2 — the choice the guards share), repairing a
   * gap payer (no org yet) with their solo org first. The repair has ONE home,
   * {@link PayerTenantScopeService.ensureActingOrg}: it heals at most once and re-resolves
   * afterwards rather than trusting `ensureSoloOrg`'s return (its owner-member insert is `ON
   * CONFLICT DO NOTHING`, so the row it would report may not be the row that exists). Returns
   * `undefined` (→ no session org claim, least privilege) if no acting org resolves even then.
   */
  private async resolveOrEnsureOrg(payerId: string): Promise<ResolvedOrg | undefined> {
    return (await this.tenancy.ensureActingOrg(payerId)) ?? undefined;
  }

  /**
   * Issue + deliver a code for an EXISTING account, reading the canonical stored contact
   * (so the `whatsapp` channel uses the on-file phone). A delivery failure is swallowed to
   * the neutral response — surfacing it would be an existence oracle (we only deliver for a
   * known account); 429/503 propagate (existence-independent). Optionally emits
   * `payer.login_requested` (login path) — never on the signup path (it has `payer.created`).
   */
  private async issueForExistingAccount(
    payerId: string,
    supplied: { email?: string; phone?: string },
    ctx: RequestContext,
    emitRequested: boolean,
  ): Promise<PayerOtpIssued> {
    const row = await this.payers.findById(payerId);

    // The OTP key is the keyed hash of the SUPPLIED contact (#2497 — the same key the
    // request/verify doors reserve under, whether it is an email or a phone).
    const contact = PayerAuthService.mustContact(supplied);
    const contactHash = this.contactHash(contact);

    // ADR-0037 Decision 5 — RESERVE but do NOT DELIVER for a suspended account.
    //
    // Placed HERE, not in `requestLogin`, because this helper is the single chokepoint both
    // doors go through: signup also lands here (an existing email `createOrGet`s back to the
    // same account), so a suspended payer could otherwise re-trigger delivery just by
    // "signing up" again. One check covers both.
    //
    // Reached BEFORE `decryptContact`: there is no reason to decrypt three PII fields for a
    // message that will never be sent.
    //
    // The reserve is the SAME call the unknown-email branch makes, so the per-account
    // cooldown, the hourly cap and the GLOBAL daily send breaker all still run and still
    // produce the same 429s. Only the ZeptoMail send is skipped — the platform stops paying
    // to mail an account it has banned, and a suspended account cannot be used to burn the
    // shared daily send ceiling.
    //
    // The HTTP response is byte-identical to the normal one; the attempt is recorded ONLY on
    // the spine, which is what makes repeated probing of a banned account visible to ops
    // without being visible to the caller.
    if (row?.status === "suspended") {
      const issued = await this.otp.issueWithoutDelivery(contactHash);
      // Emitted INSTEAD of `payer.login_requested`, not alongside it: no login code was
      // delivered, so counting one would overstate the login funnel and would bury repeated
      // probing of a banned account inside ordinary traffic.
      await this.events.emit({
        event_name: "payer.otp_suppressed",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "payer", subject_id: payerId },
        payload: { payer_id: payerId, reason: "account_suspended" },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      return issued;
    }

    const contactRow = row ? this.payers.decryptContact(row) : null;
    // The STORED contact is canonical (an existing account is never overwritten here),
    // falling back to the supplied one for a just-created row. Either may be email or
    // phone — whichever the payer signed up with (#2497).
    const deliverEmail = contactRow?.email ?? supplied.email ?? "";
    const deliverPhone = contactRow?.phone ?? supplied.phone ?? null;

    // No destination for the ACTIVE channel (a phone-only account while the method is
    // email_otp, or an email-only account while it is whatsapp): reserve WITHOUT
    // delivery — the same neutral path as the unknown/suspended branches above. The
    // reserve still runs, so cooldown/cap/429 behavior is identical; no code is sent
    // nowhere and no delivery failure is possible. (Mock WhatsApp in alpha behaves the
    // same way through the provider — this branch is for the method/contact mismatch.
    // `supabase` is intentionally NOT diverted: the adapter is documented-inert and
    // its throw is today's behavior.)
    const deliverable =
      this.method === "email_otp"
        ? deliverEmail !== ""
        : this.method === "whatsapp"
          ? deliverPhone !== null
          : true;
    if (!deliverable) {
      this.logger.warn(
        `payer login code not deliverable for active channel payer=${payerId.slice(0, 8)}…`,
      );
      return await this.otp.issueWithoutDelivery(contactHash);
    }

    let issued: PayerOtpIssued;
    try {
      issued = await this.otp.issueAndSend({
        emailHash: contactHash,
        email: deliverEmail,
        phone: deliverPhone,
        payerId,
      });
    } catch (err) {
      // Swallow ONLY a delivery failure (502) → neutral. 429 (cooldown/cap) and 503 (Redis)
      // are existence-independent (the unknown-email branch hits the same codes) → propagate.
      if (err instanceof HttpException && err.getStatus() === HttpStatus.BAD_GATEWAY) {
        this.logger.warn(
          `payer login code delivery failed (neutralized) payer=${payerId.slice(0, 8)}…`,
        );
        issued = { resendInSeconds: this.config.OTP_RESEND_COOLDOWN_SECONDS };
      } else {
        throw err;
      }
    }

    if (emitRequested) {
      await this.events.emit({
        event_name: "payer.login_requested",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "payer", subject_id: payerId },
        payload: { payer_id: payerId, method: this.method },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }
    return issued;
  }

  /**
   * The OTP key for one request: the keyed hash of the SUPPLIED contact (#2497).
   * Email keeps the exact pre-#2497 key (`pii.hmac` of the normalized email — existing
   * rows and reserves keep working); phones hash via `hashPhone` (a distinct peppered
   * domain, so an email and a phone can never share a key).
   */
  private contactHash(contact: PayerLoginContact): string {
    return contact.kind === "email"
      ? this.pii.hmac(contact.value)
      : this.pii.hashPhone(contact.value);
  }

  /**
   * Resolve the request's OTP contact (#2497 — email and/or phone, at least one per the
   * DTOs). EMAIL WINS on a both-supplied body: deterministic, identical on
   * signup/request/verify, and signup stays keyed on the email hash (the dedup the
   * unique index enforces). Throws only when NEITHER is supplied — a contract the DTO
   * refine already enforces, so this is unreachable-by-client defence in depth.
   */
  private static mustContact(contact: { email?: string; phone?: string }): PayerLoginContact {
    if (contact.email !== undefined) return { kind: "email", value: contact.email };
    if (contact.phone !== undefined) return { kind: "phone", value: contact.phone };
    throw new Error("payer auth contact requires at least one of email/phone");
  }

  /**
   * The row for an OTP contact: email and phone read their own keyed hash (#2497).
   * Email is unique (first row is the only row); a shared phone resolves to its FIRST
   * row — proving the shared contact is what OTP asserts, and the password door
   * (which demands uniqueness) re-resolves strictly below.
   */
  private async findByContact(contact: PayerLoginContact) {
    if (contact.kind === "email") return this.payers.findByEmail(contact.value);
    const [first] = await this.payers.findByPhone(contact.value);
    return first;
  }

  /**
   * POST /payer/password/set — store the payer's own login password (#2497, #2563).
   *
   * Bearer-guarded (the OTP-verified session), so only the proven account holder gets here.
   * Stores the scrypt token + pepper version + timestamp; the RAW password is never logged,
   * never evented, and never leaves this call (CLAUDE.md §2). The password write and the
   * value-free `payer.password_set` event commit in ONE transaction; the caller's session is
   * kept and every OTHER session is ended after that commit (a password change is how a payer
   * reacts to a leaked credential, so every other device must be signed out).
   */
  async setPassword(
    payerId: string,
    password: string,
    currentSid: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.storeOwnPassword(payerId, password, ctx);
    // After the commit: Redis is not transactional with Postgres. A failure THROWS (see
    // revokeAllForPayerExcept) rather than reporting a completed change that left other
    // devices signed in — the retry is the same idempotent write plus a fresh revoke.
    // The sweep runs FIRST so a slow mail provider can never delay it; the notice is sent in
    // `finally`, so it still goes out when the sweep throws.
    try {
      await this.sessions.revokeAllForPayerExcept(payerId, currentSid);
    } finally {
      await this.notice.notify(payerId, "changed");
    }
  }

  /**
   * POST /payer/login/password — verify a password and mint a session (#2497, #2563).
   *
   * The identifier is, in order: a normalized email, an E.164 phone, or the exact org
   * display name (trimmed, case-insensitive). EVERY MISS IS THE SAME NEUTRAL 401 —
   * unknown identifier, wrong password, OTP-only account (no hash), revoked password,
   * colliding org name (2+ rows), and pending status (never promoted without a fresh OTP
   * proof) are all indistinguishable (XB-H). Only a proven credential on a SUSPENDED account
   * gets the distinct 403, mirroring verifyLogin (the caller proved the account exists AND
   * the secret, so no oracle remains). Per-account attempt lockout (5 fails → 15 min,
   * Redis, fail-closed) sits beside the shared per-IP cap on the route.
   *
   * #2563 — a TEMPORARY password returns `{status:"password_change_required"}` and NO session
   * unless the request also carries `new_password`, which must pass the policy and differ
   * from the temporary one. On that step the new password is stored, every existing session is
   * ended, `payer.password_set` is emitted, and only then is a session minted.
   */
  async loginWithPassword(
    identifier: string,
    password: string,
    ctx: RequestContext,
    newPassword?: string,
  ): Promise<PayerSessionResponse | PayerPasswordChangeRequiredResponse> {
    const account = await this.resolvePasswordAccount(identifier);
    if (!account) {
      // No row: still burn one full KDF so miss/hit timing matches a real mismatch.
      this.pii.verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException("Incorrect identifier or password");
    }

    if (await this.isPasswordLockedOut(account.id)) {
      // Locked out: same neutral 401 (a 429 would announce the throttle — and the
      // account's existence — to a prober). The lockout is logged prefix-only.
      this.pii.verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException("Incorrect identifier or password");
    }

    // #2563 — a REVOKED password is closed even though the hash is still on the row. Read as a
    // miss: one full KDF, the same neutral 401, no failure counter (this credential is not a
    // guess, it is a door that was deliberately shut).
    if (account.passwordRevokedAt != null) {
      this.pii.verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException("Incorrect identifier or password");
    }

    // Fail CLOSED on an unknown pepper version OR a missing hash (OTP-only account):
    // both read exactly like a wrong password (dummy KDF burned above/below as needed).
    const verified =
      account.passwordHash !== null &&
      account.passwordPepperVersion === CURRENT_PASSWORD_PEPPER_VERSION &&
      this.pii.verifyPassword(password, account.passwordHash);
    if (!verified) {
      await this.recordPasswordFailure(account.id);
      throw new UnauthorizedException("Incorrect identifier or password");
    }
    await this.clearPasswordFailures(account.id);

    // #2563 (owner ruling 2026-11-04) — a TEMPORARY password expires. After the configured
    // TTL it is treated exactly like a wrong password: one full KDF, the same neutral 401,
    // and no forced-change prompt (an expired credential must not remain a way in).
    if (account.mustChangePassword && this.temporaryPasswordExpired(account.passwordSetAt)) {
      this.pii.verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException("Incorrect identifier or password");
    }

    if (account.status === "suspended") {
      throw new ForbiddenException("Account is suspended");
    }
    if (account.status !== "active") {
      // Pending (or any future non-active state): a password alone NEVER promotes —
      // activation is the OTP proof's job (verifyLogin). Neutral 401, no oracle.
      this.logger.warn(
        `payer password login refused for non-active account payer=${account.id.slice(0, 8)}…`,
      );
      throw new UnauthorizedException("Incorrect identifier or password");
    }

    // #2563 — FORCED CHANGE. The temporary password proves the account; it does not open a
    // session. Without a replacement the client is told to ask for one and resend.
    if (account.mustChangePassword && newPassword === undefined) {
      return { status: "password_change_required" };
    }
    if (account.mustChangePassword) {
      if (newPassword === password) {
        throw new BadRequestException("Choose a new password - it cannot be the temporary one");
      }
      const replaced = await this.replaceTemporaryPassword(
        account.id,
        newPassword!,
        account.passwordHash!,
        ctx,
      );
      // Lost a concurrent forced-change race: the other request already stored its password,
      // so this one has no business minting a session on a credential it no longer holds.
      if (!replaced) throw new UnauthorizedException("Incorrect identifier or password");
      // No caller session exists yet: every session that does exist belongs to an earlier
      // credential and must end. A failure THROWS before a new session is minted. The sweep is
      // not delayed by mail; the notice is sent in `finally`, so it goes out either way.
      try {
        await this.sessions.revokeAllForPayer(account.id);
      } finally {
        await this.notice.notify(account.id, "changed");
      }
    }

    // Lazy org-hash fill for pre-#2493 rows (best-effort — never fails a good login).
    // #2563 follow-up — NEVER for a payer who has ever held a membership in another org.
    // A team member's row can carry the founder's copied org name; writing its hash onto the
    // member would make the founder's company-name sign-in collide with theirs. If an old
    // row already carries that stale hash, clear it on the next login.
    const everMember = await this.orgs
      .hasEverBeenMemberOfOtherOrg(account.id)
      // Fail closed: an unreadable membership history skips the backfill rather than risk
      // writing the founder's company-name hash onto a member row.
      .catch(() => true);
    if (everMember) {
      if (account.orgNameLookupHash) {
        await this.payers.clearOrgLookupHash(account.id).catch((err: unknown) => {
          this.logger.warn(
            `payer stale org lookup clear failed payer=${account.id.slice(0, 8)}… reason=${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } else if (!account.orgNameLookupHash) {
      const isRoot = await this.orgs.isRootPayer(account.id).catch(() => false);
      if (isRoot) {
        await this.payers.ensureOrgLookupHash(account).catch((err: unknown) => {
          this.logger.warn(
            `payer org lookup backfill failed payer=${account.id.slice(0, 8)}… reason=${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }

    const org = await this.resolveOrEnsureOrg(account.id);
    const session = await this.sessions.create(account.id, account.role, org);
    // #2563 follow-up — strict against a revoke that commits concurrently with this sign-in.
    // The row read above said password sign-in was open; if it has since closed, the session
    // just minted must not survive. Revoke it and answer the same neutral 401 as a bad password.
    const latest = await this.payers.findById(account.id);
    if (!latest || latest.passwordRevokedAt != null) {
      await this.sessions.revoke(session.sid, account.id);
      throw new UnauthorizedException("Incorrect identifier or password");
    }
    await this.recordLogin(account.id);
    await this.events.emit({
      event_name: "payer.session_started",
      actor: { actor_type: "payer", actor_id: account.id },
      subject: { subject_type: "payer", subject_id: account.id },
      payload: {
        payer_id: account.id,
        method: "password" as PayerLoginMethodEnum,
        is_new_payer: false,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      access_token: session.token,
      token_type: "Bearer",
      expires_in_seconds: session.expiresInSeconds,
      payer_id: account.id,
      role: account.role,
      is_new_payer: false,
    };
  }

  /**
   * #2563 — true when a temporary password is past its TTL. A missing timestamp fails closed:
   * a temporary credential with no provenance is not a way in.
   */
  private temporaryPasswordExpired(passwordSetAt: Date | null): boolean {
    if (passwordSetAt === null) return true;
    return Date.now() - passwordSetAt.getTime() > this.config.PAYER_TEMP_PASSWORD_TTL_HOURS * 3_600_000;
  }

  /**
   * #2563 — the CONDITIONAL forced-change write. Only a row that still requires a change AND
   * still holds the exact temporary hash just verified is updated. Two concurrent requests
   * can both pass the password check; exactly one UPDATE matches, and the loser gets `false`.
   * The `payer.password_set` event commits on the same transaction.
   */
  private async replaceTemporaryPassword(
    payerId: string,
    newPassword: string,
    expectedTemporaryHash: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    const hash = this.pii.hashPassword(newPassword);
    return this.payers.withTransaction(async (tx) => {
      const updated = await this.payers.replaceTemporaryPassword(
        payerId,
        { hash, pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION },
        expectedTemporaryHash,
        tx,
      );
      if (!updated) return false;
      await this.events.emit({
        event_name: "payer.password_set",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "payer", subject_id: payerId },
        payload: { payer_id: payerId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
      return true;
    });
  }

  /**
   * #2563 — store the payer's own replacement password and emit `payer.password_set` in ONE
   * transaction. Used by the self-service route; the forced-change step uses the CONDITIONAL
   * `replaceTemporaryPassword` instead, because it must lose a concurrent race. The RAW
   * password never reaches this method — the caller has already hashed it into `hash`.
   */
  private async storeOwnPassword(
    payerId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<void> {
    const hash = this.pii.hashPassword(password);
    await this.payers.withTransaction(async (tx) => {
      const updated = await this.payers.setPassword(
        payerId,
        { hash, pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION },
        { tx },
      );
      if (!updated) throw new NotFoundException("Payer not found");
      await this.events.emit({
        event_name: "payer.password_set",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "payer", subject_id: payerId },
        payload: { payer_id: payerId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
    });
  }

  /** #2563 — stamp `last_login_at`; a metrics write must not fail a good sign-in. */
  private async recordLogin(payerId: string): Promise<void> {
    try {
      await this.payers.recordLogin(payerId);
    } catch (err) {
      this.logger.warn(
        `payer last_login_at update failed payer=${payerId.slice(0, 8)}… reason=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The single row a password identifier names — or null when it names none or more
   * than one (#2497). Email → one row max (unique). Phone → first match ONLY when it
   * is the only match (historical dupes log in NOBODY, neutrally). Org name → exact
   * normalized match, again only when unique. Anything else (unknown, colliding,
   * overlong) is null: the caller answers the same neutral 401.
   */
  private async resolvePasswordAccount(identifier: string) {
    if (emailSchema.safeParse(identifier).success) {
      return this.payers.findByEmail(identifier) ?? null;
    }
    if (isE164Phone(identifier)) {
      // No unique index on phone_hash (historical dupes possible): read two and
      // require exactly one — a shared phone logs in NOBODY, neutrally.
      const matches = await this.payers.findByPhone(identifier);
      return matches.length === 1 ? matches[0]! : null;
    }
    const name = identifier.trim();
    // DTO caps identifiers at 320 chars; org names cap at 200 (per PayerSignupSchema) —
    // anything longer cannot be one (and skips the HMAC work on attacker-width input).
    if (name.length === 0 || name.length > 200) return null;
    const matches = await this.payers.findByOrgName(name);
    return matches.length === 1 ? matches[0]! : null;
  }

  /** Redis client for the per-account password lockout (fail-closed on error). */
  private async passwordRedis(): Promise<RedisPasswordClient> {
    return (await this.queue.client) as unknown as RedisPasswordClient;
  }

  private static passwordAttemptsKey(payerId: string): string {
    return payerPasswordAttemptsKey(payerId);
  }

  /**
   * True while this account's password failures are locked out (#2497: N fails inside
   * the window). Keyed on the resolved `payer_id` (bounded space — never the raw
   * identifier, whose attacker-controlled width would let a prober grow Redis
   * unboundedly). Redis failure → 503 (fail-closed, mirroring the OTP reserve path).
   */
  private async isPasswordLockedOut(payerId: string): Promise<boolean> {
    let count = 0;
    try {
      const raw = await (
        await this.passwordRedis()
      ).get(PayerAuthService.passwordAttemptsKey(payerId));
      count = raw ? Number.parseInt(raw, 10) || 0 : 0;
    } catch {
      this.logger.error(
        `payer password lockout check failed (failing closed) payer=${payerId.slice(0, 8)}…`,
      );
      throw new ServiceUnavailableException("Login is temporarily unavailable, please retry");
    }
    return count >= this.config.PAYER_PASSWORD_MAX_ATTEMPTS;
  }

  /**
   * Record one failed password for this account. First failure arms the TTL (= the
   * lockout window); the window does NOT slide (a steady trickle cannot hold the lock
   * forever, and a burst hits the cap). Redis failure → 503 fail-closed (a failure we
   * cannot count is a failure we must not allow past).
   */
  private async recordPasswordFailure(payerId: string): Promise<void> {
    try {
      const redis = await this.passwordRedis();
      const count = await redis.incr(PayerAuthService.passwordAttemptsKey(payerId));
      if (count === 1)
        await redis.expire(
          PayerAuthService.passwordAttemptsKey(payerId),
          this.config.PAYER_PASSWORD_LOCKOUT_SECONDS,
        );
    } catch {
      this.logger.error(
        `payer password failure record failed (failing closed) payer=${payerId.slice(0, 8)}…`,
      );
      throw new ServiceUnavailableException("Login is temporarily unavailable, please retry");
    }
  }

  /**
   * Clear the failure counter after a successful login. Best-effort (a stale counter
   * only costs the payer future headroom, and it self-expires with the TTL) — a Redis
   * failure here logs and lets the verified login through.
   */
  private async clearPasswordFailures(payerId: string): Promise<void> {
    try {
      await (await this.passwordRedis()).del(PayerAuthService.passwordAttemptsKey(payerId));
    } catch (err) {
      this.logger.warn(
        `payer password failure clear failed payer=${payerId.slice(0, 8)}… reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private codeResponse(issued: PayerOtpIssued): PayerAuthCodeResponse {
    return {
      status: "code_sent",
      resend_in_seconds: issued.resendInSeconds,
    };
  }

  /**
   * OTP-5 no-enumeration handler for the GLOBAL daily send circuit-breaker breach. The
   * breaker trips on the existence-INDEPENDENT reserve path (run identically for a known
   * and an unknown account), so a breach surfaces as the same {@link OtpSendCapExceededException}
   * either way. Here we emit the PII-free `payer.otp_send_cap_exceeded` breach event ONCE
   * and DEGRADE to the SAME neutral "code_sent"-shaped response the unknown-account path
   * already returns — so the response is BYTE-IDENTICAL for a known vs unknown account
   * (XB-H). Any OTHER error (cooldown/cap 429, 503) is re-thrown unchanged; those already
   * propagate identically across both branches, so they are not an oracle. The breach
   * payload is AGGREGATE — no payer id, email, IP, or code.
   */
  private async neutralOnSendCapBreach(
    err: unknown,
    ctx: RequestContext,
  ): Promise<PayerAuthCodeResponse> {
    if (!(err instanceof OtpSendCapExceededException)) throw err;
    await this.events.emit({
      event_name: "payer.otp_send_cap_exceeded",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer" },
      payload: {
        channel: err.breach.channel,
        cap: "global_daily",
        limit: err.breach.limit,
        window: err.breach.window,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    // The neutral "code_sent" response the unknown-account path returns (no code is ever echoed).
    return {
      status: "code_sent",
      resend_in_seconds: this.config.OTP_RESEND_COOLDOWN_SECONDS,
    };
  }
}
