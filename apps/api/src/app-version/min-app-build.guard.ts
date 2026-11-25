import {
  HttpException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";

import {
  APP_BUILD_NUMBER_HEADER,
  APP_BUILD_NUMBER_MAX,
  APP_NAMES,
  APP_NAME_HEADER,
  APP_PLATFORMS,
  APP_PLATFORM_HEADER,
  APP_UPDATE_REQUIRED_CODE,
  type AppName,
  type AppPlatform,
} from "./app-version.constants";
import { AppVersionService, type AppConfigView } from "./app-version.service";

/** 426 Upgrade Required (Nest's HttpStatus enum has no member for it). */
export const HTTP_UPGRADE_REQUIRED = 426;

/** The methods that write. GET, HEAD and OPTIONS always pass. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The `error` of a 426: the code, a plain message, and the same policy `GET /app-config` gives. */
export interface AppUpdateRequiredError {
  readonly code: typeof APP_UPDATE_REQUIRED_CODE;
  readonly message: string;
  readonly config: AppConfigView;
}

/** What one request says about the app that sent it, or null when it says nothing usable. */
export interface AppBuildIdentity {
  readonly app: AppName;
  readonly platform: AppPlatform;
  readonly build: number;
}

/**
 * Read the three app headers. ALL THREE must be present and well formed, or the request names no
 * app build and is never blocked: the web apps send none of them, and neither does any app
 * installed before #3049 (the worker app's `x-app-build` is a commit stamp, not a number).
 */
export function readAppBuildIdentity(req: Pick<Request, "header">): AppBuildIdentity | null {
  const app = req.header(APP_NAME_HEADER)?.trim().toLowerCase();
  const platform = req.header(APP_PLATFORM_HEADER)?.trim().toLowerCase();
  const rawBuild = req.header(APP_BUILD_NUMBER_HEADER)?.trim();
  if (!isOneOf(APP_NAMES, app) || !isOneOf(APP_PLATFORMS, platform)) return null;
  if (rawBuild === undefined || !/^\d{1,10}$/.test(rawBuild)) return null;
  const build = Number(rawBuild);
  if (build > APP_BUILD_NUMBER_MAX) return null;
  return { app, platform, build };
}

function isOneOf<T extends string>(values: readonly T[], v: string | undefined): v is T {
  return v !== undefined && (values as readonly string[]).includes(v);
}

/**
 * #3048 — a write from an app build below the minimum gets 426, so an app that never makes the
 * config call is still stopped from writing in an old shape. Registered GLOBALLY (`APP_GUARD` in
 * {@link AppVersionModule}), so it runs before every route's own guards.
 *
 * Passes, always:
 *   - a read (GET, HEAD, OPTIONS);
 *   - a request without all three app headers (web apps, apps installed before #3049);
 *   - every request while the minimum for that app and platform is 0 (the seed);
 *   - every request when the policy cannot be read (fail open: see {@link AppVersionService}).
 *
 * The gate is by METHOD, not by route: a POST that only reads (the company candidate search) is
 * stopped too, which the app shows as the same "Update required" page.
 */
@Injectable()
export class MinAppBuildGuard implements CanActivate {
  // Explicit @Inject: the HTTP contract test boots this guard under vitest (no design:paramtypes).
  constructor(@Inject(AppVersionService) private readonly policy: AppVersionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(req.method.toUpperCase())) return true;
    const who = readAppBuildIdentity(req);
    if (who === null) return true;
    const config = await this.policy.blockingConfigFor(who.app, who.platform);
    if (config === null || who.build >= config.min_supported_build) return true;
    const error: AppUpdateRequiredError = {
      code: APP_UPDATE_REQUIRED_CODE,
      message: "This app version is no longer supported. Update the app to continue.",
      config,
    };
    throw new HttpException(error, HTTP_UPGRADE_REQUIRED);
  }
}
