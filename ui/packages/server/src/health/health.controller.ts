import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get()
  @HealthCheck()
  check() {
    // Empty checks array = basic liveness probe
    // Custom indicators (DB, disk) can be added in future phases
    return this.health.check([]);
  }
}
