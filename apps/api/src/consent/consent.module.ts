import { forwardRef, Module } from "@nestjs/common";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";
import { ConsentRepository } from "./consent.repository";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [ConsentController],
  providers: [ConsentService, ConsentRepository],
  exports: [ConsentRepository],
})
export class ConsentModule {}
