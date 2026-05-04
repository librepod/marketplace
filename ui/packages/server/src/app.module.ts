import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { CatalogModule } from './catalog/catalog.module';
import { InstalledModule } from './installed/installed.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [{
        rootPath: join(__dirname, '..', '..', 'client', 'dist'),
        exclude: ['/api/(.*)'],
      }],
    }),
    CatalogModule,
    InstalledModule,
    HealthModule,
  ],
})
export class AppModule {}
