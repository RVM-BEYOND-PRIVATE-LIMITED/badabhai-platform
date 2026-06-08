import { Controller, Get, Inject } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

@Controller("health")
export class HealthController {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  @Get()
  check() {
    return {
      status: "ok",
      service: "api",
      environment: this.config.NODE_ENV,
      timestamp: new Date().toISOString(),
    };
  }
}
