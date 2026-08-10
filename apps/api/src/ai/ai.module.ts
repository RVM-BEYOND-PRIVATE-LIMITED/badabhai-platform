import { Global, Module } from "@nestjs/common";
import { AiCostRecorder } from "./ai-cost-recorder.service";
import { AiService } from "./ai.service";

/** Global AI client module — chat/profiles/resume all depend on it. */
@Global()
@Module({
  providers: [AiService, AiCostRecorder],
  exports: [AiService, AiCostRecorder],
})
export class AiModule {}
