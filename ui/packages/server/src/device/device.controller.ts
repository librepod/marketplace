import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
} from '@nestjs/common';
import type { DeviceInfo } from '@librepod/shared';
import { DeviceService } from './device.service';
import {
  parseInstall,
  parsePower,
  parseSshKeys,
  parseUpdateSettings,
} from './device-input';

@Controller('device')
export class DeviceController {
  constructor(private readonly device: DeviceService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(): Promise<DeviceInfo> {
    return this.device.read();
  }

  @Put('update-settings')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  updateSettings(@Body() body: unknown): Promise<DeviceInfo> {
    return this.device.write('updates', parseUpdateSettings(body));
  }

  @Post('install')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  install(@Body() body: unknown): Promise<DeviceInfo> {
    return this.device.write('install', parseInstall(body));
  }

  @Post('power')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  power(@Body() body: unknown): Promise<DeviceInfo> {
    return this.device.write('power', parsePower(body));
  }

  @Put('ssh-keys')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  sshKeys(@Body() body: unknown): Promise<DeviceInfo> {
    return this.device.write('sshKeys', parseSshKeys(body));
  }
}
