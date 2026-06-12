import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ResumeService } from "./resume.service";
import { ResumeRepository } from "./resume.repository";
import { GenerateResumeSchema, type GenerateResumeDto } from "./resume.dto";

@Controller("resume")
export class ResumeController {
  constructor(
    private readonly resume: ResumeService,
    private readonly resumes: ResumeRepository,
  ) {}

  @Post("generate")
  @HttpCode(201)
  generate(
    @Body(new ZodValidationPipe(GenerateResumeSchema)) dto: GenerateResumeDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.resume.generate(dto, ctx);
  }

  /**
   * Read a single generated resume by id (ops read view).
   * The resume body contains the worker's OWN name by design (TD21) — it is their
   * document. The phone never appears. Exposure is bounded by RLS on generated_resumes
   * (TD20) + no Data-API consumer; closing the endpoint's authz rides the TD4 gap.
   */
  @Get(":id")
  async get(@Param("id", new ParseUUIDPipe()) id: string) {
    const resume = await this.resumes.findById(id);
    if (!resume) throw new NotFoundException(`Resume ${id} not found`);
    return {
      resume_id: resume.id,
      worker_id: resume.workerId,
      profile_id: resume.profileId,
      version: resume.version,
      resume_text: resume.resumeText,
      resume_json: resume.resumeJson,
      generated_at: resume.generatedAt,
    };
  }
}
