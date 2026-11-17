import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { StudentVisibilityService } from "../../student-move/student-visibility.service";
import type { MovedStudentRow } from "../../student-move/student-visibility.repository";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  AdminBulkStudentVisibilitySchema,
  AdminListStudentsQuerySchema,
  AdminSetStudentVisibilitySchema,
  type AdminBulkStudentVisibilityDto,
  type AdminBulkStudentVisibilityResponse,
  type AdminListStudentsQuery,
  type AdminSetStudentVisibilityDto,
  type AdminSetStudentVisibilityResponse,
  type AdminStudentPageResponse,
  type AdminStudentResponse,
} from "./admin-students.dto";

/**
 * #2887 — the moved RVM students in the admin console.
 *
 *   GET  /admin/students                       moved students, newest first (filters: import run,
 *                                              visible, branch, course).
 *   PUT  /admin/students/:workerId/visibility  turn one student's visibility on or off.
 *   POST /admin/students/visibility            the same for one import run, branch or course.
 *
 * All behind {@link AdminAuthGuard} + {@link AdminRolesGuard} with ONE capability,
 * `manage_student_visibility` (super_admin, ops_admin). All answer 404 while STUDENT_MOVE_ENABLED is
 * off, and 503 with it on and the table missing. A worker who was never moved is a 404 on the PUT.
 * The actor is always `@CurrentAdmin().id`.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminStudentsController {
  constructor(private readonly visibility: StudentVisibilityService) {}

  @Get("students")
  @RequireAdminRole("manage_student_visibility")
  async listStudents(
    @Query(new ZodValidationPipe(AdminListStudentsQuerySchema)) query: AdminListStudentsQuery,
  ): Promise<AdminStudentPageResponse> {
    const page = await this.visibility.list({
      ...(query.batch_id !== undefined ? { batchId: query.batch_id } : {}),
      ...(query.visible !== undefined ? { visible: query.visible === "true" } : {}),
      ...(query.branch !== undefined ? { branch: query.branch } : {}),
      ...(query.course !== undefined ? { course: query.course } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    return { students: page.students.map(toResponse), next_cursor: page.nextCursor };
  }

  @Put("students/:workerId/visibility")
  @HttpCode(200)
  @RequireAdminRole("manage_student_visibility")
  async setStudentVisibility(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("workerId", new ParseUUIDPipe()) workerId: string,
    @Body(new ZodValidationPipe(AdminSetStudentVisibilitySchema)) dto: AdminSetStudentVisibilityDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSetStudentVisibilityResponse> {
    const out = await this.visibility.setOne(
      admin.id,
      workerId,
      { visible: dto.visible, reason: dto.reason_text },
      ctx,
    );
    return { student: toResponse(out.student), changed: out.changed };
  }

  @Post("students/visibility")
  @HttpCode(200)
  @RequireAdminRole("manage_student_visibility")
  async setBulkStudentVisibility(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminBulkStudentVisibilitySchema))
    dto: AdminBulkStudentVisibilityDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminBulkStudentVisibilityResponse> {
    const selector =
      dto.batch_id !== undefined
        ? ({ kind: "batch", batchId: dto.batch_id } as const)
        : dto.branch !== undefined
          ? ({ kind: "branch", branch: dto.branch } as const)
          : ({ kind: "course", course: dto.course! } as const);
    return this.visibility.setBulk(
      admin.id,
      selector,
      { visible: dto.visible, reason: dto.reason_text },
      ctx,
    );
  }
}

function toResponse(row: MovedStudentRow): AdminStudentResponse {
  return {
    worker_id: row.workerId,
    visible: row.visible,
    batch_id: row.batchId,
    branch: row.branch,
    course: row.course,
    changed_at: row.changedAt.toISOString(),
  };
}
