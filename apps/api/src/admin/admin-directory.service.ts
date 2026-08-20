import { Injectable } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminDirectoryRepository } from "./admin-directory.repository";
import { AdminIdentityService } from "./admin-identity.service";
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
    const names = await this.identity.resolve(
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
