import { Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";

import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  DEFAULT_DISPLAY_THEME,
  isDisplayTheme,
  type DisplayPrefsResponse,
  type DisplayPrefsSubjectKind,
  type DisplayTheme,
} from "@badabhai/types";

import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { RolloutCaller } from "../feature-rollout/rollout-caller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { DisplayPrefsRepository } from "./display-prefs.repository";

/** Whose row a request reads or writes: the realm guard's own id, never a body's or a path's. */
interface Subject {
  readonly kind: DisplayPrefsSubjectKind;
  readonly id: string;
}

/**
 * A missing table (42P01: 0165 not applied yet) or column (42703: a later column not applied yet).
 * Either fails the request CLOSED (light / `theme_open: false`, or a 404); anything else propagates.
 */
const MISSING_SCHEMA: ReadonlySet<string> = new Set(["42P01", "42703"]);

/**
 * #2837 — what a PATCH answers when the login's own row is gone by the time it writes: its realm
 * guard's refusal of a revoked session, word for word. Every managed deletion revokes the sessions
 * before it deletes the row, so that is the truth, and the reply is the one the same request gets a
 * moment later from the guard: the client's ordinary re-auth path runs, never a 500.
 */
const LOGIN_GONE: Readonly<Record<DisplayPrefsSubjectKind, string>> = {
  worker: "Invalid or expired session",
  payer_user: "Invalid or expired payer session",
  admin: "Invalid or expired admin session",
};

/** What every route answers while the theme is closed for the login. A fresh object per reply. */
const closed = (): DisplayPrefsResponse => ({ theme: DEFAULT_DISPLAY_THEME, theme_open: false });

/** The theme a stored value puts in force: no row (or a value this build does not know) is light. */
const inForce = (stored: string | null): DisplayTheme =>
  isDisplayTheme(stored) ? stored : DEFAULT_DISPLAY_THEME;

/**
 * DISPLAY PREFERENCES (#2819) — one login's theme, saved on the server so it follows the person
 * across devices and between the web portal and the app. The logins are a worker, a company or
 * agency login (the PERSON, keyed on `payers.id`, never on the tenant key) and an admin. Business
 * rules only: the rows are {@link DisplayPrefsRepository}'s, the switch is `FeatureRolloutService`'s.
 *
 * THE SWITCH FIRST, ALWAYS. `THEME_ROLLOUT` (#2820) decides per login, through `isThemeOpenFor`.
 * Closed, a GET answers light / `theme_open: false` WITHOUT reading the table, and a PATCH is a plain
 * 404 that writes nothing. A stored choice is a preference, not a restriction: it stays in the table
 * and is served again when the login is piloted again. That is also what makes 0165
 * apply-before-pilot rather than apply-before-deploy.
 *
 * FAIL CLOSED ON A MISSING SCHEMA. Open before 0165 is applied, the table read or write raises 42P01
 * (42703 for a missing column): GET answers closed, PATCH 404s, and the log carries the ids and the
 * SQLSTATE only. Never a 500 for those two.
 *
 * WHO ASKS. A worker's and an admin's {@link RolloutCaller} are built by the controller from the
 * guard's object as it came (`rolloutCaller.worker(worker)` from `@CurrentWorker()`), and the same
 * object names the row. A company login asks `isThemeOpenForPayer` with a LAZY resolve of the
 * `@CurrentPayer()` login, so the tenancy resolver runs only while the switch is `pilot` (review
 * M1): `off` and `on` read no membership. A team member inherits the company's pilot place under
 * `PAYER_ORG_TENANCY_MODE=on`, but the ROW stays the login's, and a tenancy refusal closes the
 * theme, never a 403. `rollout-caller-arguments.static.test.ts` pins both shapes.
 */
@Injectable()
export class DisplayPrefsService {
  private readonly logger = new Logger(DisplayPrefsService.name);

  constructor(
    private readonly repo: DisplayPrefsRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly events: EventsService,
  ) {}

  /** `GET workers/me/display-prefs`. `caller` is `rolloutCaller.worker(worker)`, the same object. */
  readForWorker(worker: AuthenticatedWorker, caller: RolloutCaller): Promise<DisplayPrefsResponse> {
    return this.read({ kind: "worker", id: worker.id }, () => this.isOpenFor(caller, "worker"));
  }

  /** `PATCH workers/me/display-prefs`. */
  writeForWorker(
    worker: AuthenticatedWorker,
    caller: RolloutCaller,
    theme: DisplayTheme,
    ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    return this.write(
      { kind: "worker", id: worker.id },
      () => this.isOpenFor(caller, "worker"),
      theme,
      ctx,
    );
  }

  /** `GET admin/me/display-prefs`. `caller` is `rolloutCaller.admin(admin)`, the same object. */
  readForAdmin(admin: AuthenticatedAdmin, caller: RolloutCaller): Promise<DisplayPrefsResponse> {
    return this.read({ kind: "admin", id: admin.id }, () => this.isOpenFor(caller, "admin"));
  }

  /** `PATCH admin/me/display-prefs`. */
  writeForAdmin(
    admin: AuthenticatedAdmin,
    caller: RolloutCaller,
    theme: DisplayTheme,
    ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    return this.write(
      { kind: "admin", id: admin.id },
      () => this.isOpenFor(caller, "admin"),
      theme,
      ctx,
    );
  }

  /**
   * `GET payer/me/display-prefs`: the login's own row; the company's pilot place opens it. `payer`
   * is the controller's `@CurrentPayer()` object, and the resolve stays lazy (pilot only).
   */
  readForPayer(payer: AuthenticatedPayer): Promise<DisplayPrefsResponse> {
    return this.read({ kind: "payer_user", id: payer.id }, () =>
      this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)),
    );
  }

  /** `PATCH payer/me/display-prefs`. */
  writeForPayer(
    payer: AuthenticatedPayer,
    theme: DisplayTheme,
    ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    return this.write(
      { kind: "payer_user", id: payer.id },
      () => this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)),
      theme,
      ctx,
    );
  }

  /** The theme in force for the login, or the closed reply. A read: no event. */
  private async read(
    subject: Subject,
    isOpen: () => Promise<boolean>,
  ): Promise<DisplayPrefsResponse> {
    if (!(await isOpen())) return closed();
    let stored: string | null;
    try {
      stored = await this.repo.findTheme(subject.kind, subject.id);
    } catch (err) {
      if (this.failedClosed(err, "read", subject)) return closed();
      throw err;
    }
    return { theme: inForce(stored), theme_open: true };
  }

  /**
   * Store the login's choice and answer the theme now in force.
   *
   * PERSISTS ONLY A REAL CHANGE. The theme already in force (a retried tap, or `light` from a login
   * with no row, since no row IS light) is a 200 that writes nothing and emits nothing.
   *
   * ONE TRANSACTION for the row and `display_prefs.changed`: an emit failure rolls the choice back,
   * so the spine and the table never disagree. The row is locked for the duration, so two
   * concurrent changes serialise and each reports the theme it replaced. Two concurrent FIRST
   * choices cannot both insert: the loser locks the winner's row and decides again, so the later
   * request wins and its event's `from` is the winner's theme.
   *
   * NEVER AFTER AN ERASURE (#2837, review L3). The table has no FK, so the transaction's FIRST
   * statement takes `FOR KEY SHARE` on the login's own row (`lockSubject`). A login deleted while
   * this request was past its guard answers the guard's own 401 ({@link LOGIN_GONE}) and writes
   * nothing; an erasure that starts after the lock waits for this commit and then deletes the row.
   */
  private async write(
    subject: Subject,
    isOpen: () => Promise<boolean>,
    theme: DisplayTheme,
    ctx: RequestContext,
  ): Promise<DisplayPrefsResponse> {
    if (!(await isOpen())) throw new NotFoundException();

    let replaced: DisplayTheme | null;
    try {
      replaced = await this.repo.withTransaction(async (tx) => {
        if (!(await this.repo.lockSubject(subject.kind, subject.id, tx))) {
          this.logger.warn(
            `display prefs: write refused, login gone (kind=${subject.kind} id=${subject.id})`,
          );
          throw new UnauthorizedException(LOGIN_GONE[subject.kind]);
        }
        const held = await this.repo.lockTheme(subject.kind, subject.id, tx);
        let from = inForce(held);
        if (from === theme) return null;
        if (held !== null) {
          await this.repo.updateTheme(subject.kind, subject.id, theme, tx);
        } else if (!(await this.repo.insertTheme(subject.kind, subject.id, theme, tx))) {
          // A concurrent FIRST choice committed its row after our lock saw none.
          from = inForce(await this.repo.lockTheme(subject.kind, subject.id, tx));
          if (from === theme) return null;
          await this.repo.updateTheme(subject.kind, subject.id, theme, tx);
        }
        await this.events.emit({
          event_name: "display_prefs.changed",
          ...spineIdentity(subject),
          payload: {
            subject_kind: subject.kind,
            subject_id: subject.id,
            from,
            to: theme,
          } satisfies PayloadInputOf<"display_prefs.changed">,
          // NO idempotency key, deliberately (the résumé-skin precedent). Exactly-once comes from
          // the transaction (the event commits iff the change does) and from the no-op above (a
          // retry finds the theme already in force). A `from:to` key would be WRONG: a login may go
          // light → dark → light → dark, and the second light → dark is a real change.
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });
        return from;
      });
    } catch (err) {
      if (this.failedClosed(err, "write", subject)) throw new NotFoundException();
      throw err;
    }

    if (replaced !== null) {
      this.logger.log(
        `display prefs changed (kind=${subject.kind} id=${subject.id} ${replaced} -> ${theme})`,
      );
    }
    return { theme, theme_open: true };
  }

  /**
   * A worker's or an admin's switch answer. The kind check is belt and braces: the controller
   * builds the caller from the same guard object that names the row, so they always agree.
   */
  private isOpenFor(caller: RolloutCaller, kind: "worker" | "admin"): Promise<boolean> {
    if (caller.kind !== kind) return Promise.resolve(false);
    return this.rollout.isThemeOpenFor(caller);
  }

  /** True (and logged, ids and SQLSTATE only) when `err` is a missing table or column. */
  private failedClosed(err: unknown, op: "read" | "write", subject: Subject): boolean {
    const sqlstate = sqlStateOf(err);
    if (sqlstate === undefined || !MISSING_SCHEMA.has(sqlstate)) return false;
    this.logger.warn(
      `display prefs: ${op} failed closed (kind=${subject.kind} id=${subject.id} sqlstate=${sqlstate})`,
    );
    return true;
  }
}

/**
 * The envelope's actor and subject for a change: the login acts on itself. An admin is the
 * `admin_session` subject (its `subject_id` is `admin_users.id`), as every event about an admin's own
 * account is (`admin-account-event.ts`); a company or agency login is `payer`, as `payer.account_updated`.
 */
function spineIdentity(subject: Subject) {
  switch (subject.kind) {
    case "worker":
      return {
        actor: { actor_type: "worker" as const, actor_id: subject.id },
        subject: { subject_type: "worker" as const, subject_id: subject.id },
      };
    case "payer_user":
      return {
        actor: { actor_type: "payer" as const, actor_id: subject.id },
        subject: { subject_type: "payer" as const, subject_id: subject.id },
      };
    case "admin":
      return {
        actor: { actor_type: "admin" as const, actor_id: subject.id },
        subject: { subject_type: "admin_session" as const, subject_id: subject.id },
      };
  }
}
