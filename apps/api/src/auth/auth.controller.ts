import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AuthService } from "./auth.service";
import { OtpRequestSchema, OtpVerifySchema, type OtpRequestDto, type OtpVerifyDto } from "./auth.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("otp/request")
  @HttpCode(200)
  requestOtp(
    @Body(new ZodValidationPipe(OtpRequestSchema)) dto: OtpRequestDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.auth.requestOtp(dto.phone, ctx);
  }

  @Post("otp/verify")
  @HttpCode(200)
  verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) dto: OtpVerifyDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.auth.verifyOtp(dto.phone, dto.otp, ctx);
  }
}
