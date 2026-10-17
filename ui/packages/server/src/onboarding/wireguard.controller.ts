import { BadRequestException, Controller, Get, Param, Post, Body, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { WgPeer } from '@librepod/shared';
import { WgEasyService } from './wg-easy.service';
import { OnboardingGuard } from './onboarding.guard';

// ids are wg-easy clientIds used in proxy URLs — keep them path-safe
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

@Controller('bootstrap/wireguard')
@UseGuards(OnboardingGuard)
export class WireguardController {
  constructor(private readonly wgEasy: WgEasyService) {}

  @Get()
  async list(): Promise<{ peers: WgPeer[] }> {
    return { peers: await this.wgEasy.listClients() };
  }

  @Post('peer')
  async createPeer(@Body() body: { name?: string }): Promise<{ clientId: string; name: string }> {
    const name = (body.name ?? '').trim() || 'my-device';
    if (name.length > 64 || /[/\\?%*:|"<>]/.test(name)) {
      throw new BadRequestException('invalid device name');
    }
    const { clientId } = await this.wgEasy.createClient(name);
    return { clientId, name };
  }

  @Get('clients/:id/configuration')
  async configuration(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!SAFE_ID.test(id)) throw new BadRequestException('invalid client id');
    const config = await this.wgEasy.clientConfiguration(id);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="librepod-${id}.conf"`);
    res.send(config);
  }

  @Get('clients/:id/qrcode.svg')
  async qrcode(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!SAFE_ID.test(id)) throw new BadRequestException('invalid client id');
    const svg = await this.wgEasy.clientQrSvg(id);
    res.setHeader('content-type', 'image/svg+xml');
    res.send(svg);
  }
}
