import { Controller, Get, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { MatchSkillsService } from "../match/match-skills.service";

/**
 * Admin twin of `GET /payer/match/skills` (#2207): the closed match-skill vocabulary and the
 * runtime cap, for the Admin Portal agency match-skill editor (#2192).
 *
 * Same guard set and capability as {@link AgencyJobsAdminController}, because its only consumer
 * is that trio's editor: an admin who cannot set agency match skills has no use for the picker.
 *
 * READ-ONLY, so it emits no event (the payer twin's rule): it returns a checked-in constant and
 * one config integer. The decision taken with it is evented by the PUT (`job.updated`).
 * PII-free by construction: closed-set ids, checked-in labels and an integer.
 */
@Controller("admin/match")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AgencyMatchSkillsAdminController {
  constructor(private readonly skills: MatchSkillsService) {}

  @Get("skills")
  @RequireAdminRole("manage_agency_match_skills")
  list() {
    return this.skills.listVocabulary();
  }
}
