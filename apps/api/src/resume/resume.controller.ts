import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ResumeService } from "./resume.service";
import { GenerateResumeSchema, type GenerateResumeDto } from "./resume.dto";

@Controller("resume")
export class ResumeController {
  constructor(private readonly resume: ResumeService) {}

  @Post("generate")
  @HttpCode(201)
  generate(
    @Body(new ZodValidationPipe(GenerateResumeSchema)) dto: GenerateResumeDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.resume.generate(dto, ctx);
  }
}
