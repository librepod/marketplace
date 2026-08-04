import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { AuthGuard } from './auth.guard';
import { CasdoorService } from './casdoor.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController, MeController],
  providers: [
    CasdoorService,
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
