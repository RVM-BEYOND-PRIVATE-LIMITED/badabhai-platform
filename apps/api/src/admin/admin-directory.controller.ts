import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminDirectoryService } from "./admin-directory.service";
import {
  AdminDirectoryQuerySchema,
  type AdminDirectoryQueryDto,
} from "./admin-directory.dto";

/**
 * Read-only ADMINISTRATION API (BP-3) — the admin directory and the capability matrix.
 *
 * WHY IT EXISTS: ADMIN-3a shipped the governed admin-management ACTIONS (invite, change
 * role, reset MFA, suspend) with no way to list an admin. Exactly the discovery gap the
 * payer actions had — and worse here, because `manage_admins` is the break-glass capability
 * and the accounts it governs are the ones with the most reach.
 *
 * RBAC — the two routes are deliberately gated DIFFERENTLY:
 *
 *   - `GET /admin/admins` requires `manage_admins` (**super_admin only**). Who holds admin
 *     access, who has no second factor, and who has gone stale is a map of the platform's
 *     softest targets. It is scoped to the role that can act on it, not to the read floor.
 *
 *   - `GET /admin/capabilities` requires `read_entities` (all four roles). The matrix is
 *     published in ADR-0025 §3.1 and describes the caller's own limits — an analyst seeing
 *     that `export` is denied to them learns nothing an error message would not tell them,
 *     and hiding it would only make the portal's own permission model opaque to the people
 *     working inside it.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminDirectoryController {
  constructor(private readonly service: AdminDirectoryService) {}

  /**
   * The faceless admin directory. The caller's id comes from the SESSION (`@CurrentAdmin`),
   * never a query param — it is used only to mark which row is "you".
   */
  @Get("admins")
  @RequireAdminRole("manage_admins")
  directory(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminDirectoryQuerySchema)) query: AdminDirectoryQueryDto,
  ) {
    return this.service.directory(query, admin.id);
  }

  /** The role→capability matrix, served so the portal never carries a second copy. */
  @Get("capabilities")
  @RequireAdminRole("read_entities")
  capabilities() {
    return this.service.capabilityMatrix();
  }
}
