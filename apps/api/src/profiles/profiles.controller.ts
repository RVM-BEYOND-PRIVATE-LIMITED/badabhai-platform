import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ProfilesService } from "./profiles.service";
import {
  ExtractProfileSchema,
  ConfirmProfileSchema,
  type ExtractProfileDto,
  type ConfirmProfileDto,
} from "./profiles.dto";

@Controller("profile")
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Post("extract")
  @HttpCode(201)
  extract(
    @Body(new ZodValidationPipe(ExtractProfileSchema)) dto: ExtractProfileDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiles.extract(dto, ctx);
  }

  @Post("confirm")
  @HttpCode(200)
  confirm(
    @Body(new ZodValidationPipe(ConfirmProfileSchema)) dto: ConfirmProfileDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiles.confirm(dto, ctx);
  }
}
