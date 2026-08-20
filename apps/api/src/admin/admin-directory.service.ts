import { Injectable, Logger } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminDirectoryRepository } from "./admin-directory.repository";
import { AdminIdentityService, ADMIN_IDENTITY_MAX_SUBJECTS } from "./admin-identity.service";
import {
  ADMIN_CAPABILITIES,
  ADMIN_CAPABILITY_MATRIX,
  can,
} from "./admin-capabilities";
import type {
  AdminCapabilityMatrixResponse,
  AdminDirectoryQueryDto,
  AdminDirectoryResponse,
} from "./admin-directory.dto";

/** The four roles, in privilege order — the order the UI renders columns in. */
const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];

@Injectable()
export class AdminDirectoryService {
  private readonly logger = new Logger(AdminDirectoryService.name);

  constructor(
    private readonly repo: AdminDirectoryRepository,
    private readonly identity: AdminIdentityService,
  ) {}

  /**
   * The admin directory, with names when the caller may see them.
   *
   * The name gate is `read_identity`, NOT the route's `manage_admins`, even though today only a
   * super_admin can reach this route and a super_admin holds both. Reusing the route capability
   * would mean "can manage admins" silently implied "can read identities" — so the day
   * `manage_admins` is granted to anyone else, or the directory route is opened up, the
   * identity decision would travel with it unnoticed. One capability, one meaning.
   *
   * ── THE UNPAGINATED SHAPE MEETS THE 50-NAME RESPONSE BOUND ────────────────────────────
   * This route is deliberately unpaginated (`ADMIN_DIRECTORY_MAX = 500` is a sanity cap, not a
   * page size), so above `ADMIN_IDENTITY_MAX_SUBJECTS` admins the identity service refuses the
   * whole set and every row comes back WITHOUT a name — the row data itself is unaffected.
   *
   * That is the deliberate choice over the two alternatives. Naming only the first fifty would
   * report the rest as `name: null`, which on this contract MEANS "no name on record" — a lie
   * shaped like data, on the one screen whose job is security audit. Truncating the LIST to
   * fifty would drop admin accounts off that screen to make room for names, which inverts what
   * the screen is for. Serving every row faceless keeps the audit answer complete and honest,
   * and the refusal is LOGGED so it is diagnosable rather than mysterious. If the platform ever
   * runs >50 admins the fix is to paginate this route — a deliberate change to a shipped
   * contract, not a silent one.
   */
  async directory(
    admin: AuthenticatedAdmin,
    dto: AdminDirectoryQueryDto,
    ctx: RequestContext,
  ): Promise<AdminDirectoryResponse> {
    const [admins, activeSuperAdmins] = await Promise.all([
      this.repo.list({ role: dto.role, status: dto.status }, admin.id),
      // Counted over ALL admins, never over the filtered page: "how many people hold the
      // keys" must not change because someone filtered the table to `support`.
      this.repo.countActiveSuperAdmins(),
    ]);
    // The over-bound case is DETECTED HERE rather than left to the identity service's backstop.
    // Both refuse identically (every row faceless) — but `resolve` logs its refusal at ERROR, on
    // the stated grounds that it can only mean "a name-bearing list forgot to clamp", i.e. a
    // CALLER BUG. This caller is not one: the unpaginated shape is deliberate and documented
    // above, so past the 51st admin account every single load of `/admins` would emit an
    // ERROR-level line, forever, for a steady state nobody can fix from the code. In a repo
    // where ERROR is an alerting level, that is how a real alert gets trained away.
    //
    // So it is a WARN naming the actual remedy, and the backstop in `resolve` keeps its ERROR
    // meaning for the case it was written for.
    const overBound = admins.length > ADMIN_IDENTITY_MAX_SUBJECTS;
    if (overBound && this.identity.isPermitted(admin)) {
      this.logger.warn(
        `admin directory holds ${admins.length} accounts, above the ${ADMIN_IDENTITY_MAX_SUBJECTS}-name ` +
          `response bound; serving every row WITHOUT a name. Paginate this route to restore names.`,
      );
    }
    const names = overBound
      ? null
      : await this.identity.resolve(
          admin,
          "admins",
          admins.map((a) => a.id),
          // Unpaginated LIST, so no single subject — the same shape as the entity lists.
          null,
          ctx,
        );
    return {
      admins: names ? admins.map((a) => ({ ...a, name: names.get(a.id) ?? null })) : admins,
      active_super_admins: activeSuperAdmins,
    };
  }

  /**
   * The capability matrix, derived through {@link can} — the same function the guard calls.
   *
   * Not read off `ADMIN_CAPABILITY_MATRIX` directly: reading the constant a second way would
   * let this route and the guard disagree if the lookup ever gained a rule (a deny-list, a
   * role hierarchy). Deriving it means what the Roles screen shows is, by construction,
   * exactly what the server permits.
   */
  capabilityMatrix(): AdminCapabilityMatrixResponse {
    return {
      roles: ROLES,
      matrix: ADMIN_CAPABILITIES.map((capability) => ({
        capability,
        roles: ROLES.filter((role) => can(role, capability)),
      })),
    };
  }
}

/**
 * Exported for the drift test: the constant this route must agree with. Importing it here
 * keeps the test honest about which source it is comparing against.
 */
export { ADMIN_CAPABILITY_MATRIX };
