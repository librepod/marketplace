import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MarketplaceConfig } from '@librepod/shared';

/**
 * Public, unauthenticated device configuration the SPA needs to build
 * user-facing links.
 *
 * `baseDomain` is read from the same `BASE_DOMAIN` env var substituted into
 * app templates at install time (see InstalledService), so the per-app
 * `https://<name>.<baseDomain>` "Open app" link stays in sync with the actual
 * Traefik IngressRoute host the app was deployed under.
 */
@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  findAll(): MarketplaceConfig {
    return {
      baseDomain: this.config.get<string>('BASE_DOMAIN', 'libre.pod'),
    };
  }
}
