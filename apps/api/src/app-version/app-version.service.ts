import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AppReleasePolicyRow } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";

import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import {
  APP_NAMES,
  APP_PLATFORMS,
  DEFAULT_APP_MESSAGE_KEY,
  type AppName,
  type AppPlatform,
} from "./app-version.constants";
import { AppVersionRepository, type AppReleasePolicyWrite } from "./app-version.repository";

/**
 * One app and platform's release policy — the body of `GET /app-config` and the `config` of a
 * 426. Public by design: closed values, integers and a public store link only.
 */
export interface AppConfigView {
  readonly app: AppName;
  readonly platform: AppPlatform;
  readonly min_supported_build: number;
  readonly latest_build: number;
  readonly store_url: string | null;
  readonly message_key: string;
}

/** The admin screen's row: the public view plus who changed it and when. */
export interface AppReleasePolicyAdminView extends AppConfigView {
  readonly updated_by: string | null;
  readonly updated_at: string | null;
}

/** The answer to a set: the row after the call, and whether it changed. */
export interface SetAppReleasePolicyResult {
  readonly policy: AppReleasePolicyAdminView;
  readonly changed: boolean;
}

const UNDEFINED_TABLE = "42P01";
/** The policy cache lives this long; a set clears it, so the admin sees the change at once. */
const CACHE_TTL_MS = 30_000;

/**
 * #3048 — the minimum supported app build per app (`worker`, `payer`) and platform (`android`,
 * `ios`). The migration seeds all four rows at minimum 0, which blocks nobody; the owner raises a
 * minimum from the admin route without a release.
 *
 * Readers: the public `GET /app-config` (the apps' start-up check, #3049) and the global
 * {@link MinAppBuildGuard} (426 on a write from a build below the minimum).
 *
 * FAIL OPEN for the guard, and that is deliberate. This is a compatibility gate, not
 * authentication or privacy (CLAUDE.md §3's fail-closed list): an unreadable policy must never
 * lock a worker out of writing, the same rule #3049 gives the apps for an unreachable config. A
 * read error answers "no minimum" and logs the app and platform only. The public read answers 503
 * on a read error (the apps then let the user in); the admin write answers 503 while the table is
 * missing.
 */
@Injectable()
export class AppVersionService {
  private readonly logger = new Logger(AppVersionService.name);
  private cachedAt: number | null = null;
  private cachedRows: AppReleasePolicyRow[] | null = null;

  // Explicit @Inject: vitest's esbuild transform does not emit design:paramtypes, and the HTTP
  // contract test boots this service for real.
  constructor(
    @Inject(AppVersionRepository) private readonly repo: AppVersionRepository,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /**
   * One app and platform's policy for the public route. A missing row reads as the seed (minimum
   * 0: blocks nobody).
   *
   * @throws ServiceUnavailableException — the policy could not be read.
   */
  async getConfig(app: AppName, platform: AppPlatform): Promise<AppConfigView> {
    let rows: AppReleasePolicyRow[];
    try {
      rows = await this.allRows();
    } catch (err) {
      this.logger.error(
        `app_release_policy read failed app=${app} platform=${platform} sqlstate=${sqlStateOf(err) ?? "-"}`,
      );
      throw new ServiceUnavailableException();
    }
    return publicView(findRow(rows, app, platform), app, platform);
  }

  /**
   * The guard's read: the policy when it says to block anything, else null. Null on a read error
   * too (fail open — see the class comment), and on a missing row or a minimum of 0.
   */
  async blockingConfigFor(app: AppName, platform: AppPlatform): Promise<AppConfigView | null> {
    let rows: AppReleasePolicyRow[];
    try {
      rows = await this.allRows();
    } catch (err) {
      this.logger.error(
        `app_release_policy read failed (guard fails open) app=${app} platform=${platform} sqlstate=${sqlStateOf(err) ?? "-"}`,
      );
      return null;
    }
    const row = findRow(rows, app, platform);
    if (row === null || row.minSupportedBuild <= 0) return null;
    return publicView(row, app, platform);
  }

  /** Every app and platform, with its policy (a missing row reads as the seed). */
  async getAll(): Promise<{ policies: AppReleasePolicyAdminView[] }> {
    try {
      const rows = await this.allRows();
      const policies: AppReleasePolicyAdminView[] = [];
      for (const app of APP_NAMES) {
        for (const platform of APP_PLATFORMS) {
          policies.push(adminView(findRow(rows, app, platform), app, platform));
        }
      }
      return { policies };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  /**
   * Set one app and platform's policy. A set that changes nothing writes nothing and emits
   * nothing. The row write and `app_version.policy_changed` commit together.
   *
   * @throws NotFoundException — the row is missing (the migration seed was not applied).
   * @throws ServiceUnavailableException — the table is missing (the migration is not applied).
   */
  async set(
    adminId: string,
    app: AppName,
    platform: AppPlatform,
    input: AppReleasePolicyWrite,
    ctx: RequestContext,
  ): Promise<SetAppReleasePolicyResult> {
    try {
      const out = await this.repo.withTransaction(async (tx) => {
        const live = await this.repo.findForUpdate(tx, app, platform);
        if (live === null) throw new NotFoundException("app_release_policy row missing");
        if (
          live.minSupportedBuild === input.minSupportedBuild &&
          live.latestBuild === input.latestBuild &&
          live.storeUrl === input.storeUrl &&
          live.messageKey === input.messageKey
        ) {
          return { row: live, changed: false };
        }
        const row = await this.repo.update(tx, app, platform, { ...input, updatedBy: adminId });
        const payload: PayloadInputOf<"app_version.policy_changed"> = {
          app,
          platform,
          old_min_supported_build: live.minSupportedBuild,
          new_min_supported_build: row.minSupportedBuild,
          old_latest_build: live.latestBuild,
          new_latest_build: row.latestBuild,
          store_url: row.storeUrl,
          message_key: row.messageKey,
          updated_by_admin_id: adminId,
        };
        await this.events.emit({
          event_name: "app_version.policy_changed",
          actor: { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "admin_session", subject_id: adminId },
          payload,
          idempotencyKey: `app_version.policy_changed:${app}:${platform}:${adminId}:${ctx.requestId}`,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });
        return { row, changed: true };
      });
      this.cachedAt = null;
      this.cachedRows = null;
      return { policy: adminView(out.row, app, platform), changed: out.changed };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  private async allRows(): Promise<AppReleasePolicyRow[]> {
    const now = Date.now();
    if (this.cachedRows !== null && this.cachedAt !== null && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedRows;
    }
    const rows = await this.repo.all();
    this.cachedRows = rows;
    this.cachedAt = now;
    return rows;
  }

  private missingTableAs503(err: unknown): unknown {
    if (sqlStateOf(err) === UNDEFINED_TABLE) {
      this.logger.error(
        `app_release_policy missing (sqlstate=${UNDEFINED_TABLE}); apply the app_release_policy migration`,
      );
      return new ServiceUnavailableException();
    }
    return err;
  }
}

function findRow(
  rows: readonly AppReleasePolicyRow[],
  app: AppName,
  platform: AppPlatform,
): AppReleasePolicyRow | null {
  return rows.find((r) => r.app === app && r.platform === platform) ?? null;
}

function publicView(
  row: AppReleasePolicyRow | null,
  app: AppName,
  platform: AppPlatform,
): AppConfigView {
  return {
    app,
    platform,
    min_supported_build: row?.minSupportedBuild ?? 0,
    latest_build: row?.latestBuild ?? 0,
    store_url: row?.storeUrl ?? null,
    message_key: row?.messageKey ?? DEFAULT_APP_MESSAGE_KEY,
  };
}

function adminView(
  row: AppReleasePolicyRow | null,
  app: AppName,
  platform: AppPlatform,
): AppReleasePolicyAdminView {
  return {
    ...publicView(row, app, platform),
    updated_by: row?.updatedBy ?? null,
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}
