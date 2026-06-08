import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service";

/** Global AI client module — chat/profiles/resume all depend on it. */
@Global()
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
