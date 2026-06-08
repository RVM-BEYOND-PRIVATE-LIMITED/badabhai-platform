import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ChatService } from "./chat.service";
import {
  StartSessionSchema,
  PostMessageSchema,
  type StartSessionDto,
  type PostMessageDto,
} from "./chat.dto";

@Controller("chat")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post("session")
  @HttpCode(201)
  startSession(
    @Body(new ZodValidationPipe(StartSessionSchema)) dto: StartSessionDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.startSession(dto.worker_id, ctx);
  }

  @Post("message")
  @HttpCode(201)
  postMessage(
    @Body(new ZodValidationPipe(PostMessageSchema)) dto: PostMessageDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.postMessage(dto, ctx);
  }
}
