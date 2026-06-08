import { Body, Controller, Headers, HttpCode, Ip, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ConsentService } from "./consent.service";
import { AcceptConsentSchema, type AcceptConsentDto } from "./consent.dto";

@Controller("consent")
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Post("accept")
  @HttpCode(201)
  accept(
    @Body(new ZodValidationPipe(AcceptConsentSchema)) dto: AcceptConsentDto,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    return this.consent.accept(dto, ip, userAgent, ctx);
  }
}
