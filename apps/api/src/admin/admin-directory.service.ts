import { Injectable } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import { AdminDirectoryRepository } from "./admin-directory.repository";
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
  constructor(private readonly repo: AdminDirectoryRepository) {}

  async directory(
    dto: AdminDirectoryQueryDto,
    selfId: string,
  ): Promise<AdminDirectoryResponse> {
    const [admins, activeSuperAdmins] = await Promise.all([
      this.repo.list({ role: dto.role, status: dto.status }, selfId),
      // Counted over ALL admins, never over the filtered page: "how many people hold the
      // keys" must not change because someone filtered the table to `support`.
      this.repo.countActiveSuperAdmins(),
    ]);
    return { admins, active_super_admins: activeSuperAdmins };
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
