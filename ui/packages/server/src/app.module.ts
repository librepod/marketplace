import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { InstalledModule } from './installed/installed.module';
import { HealthModule } from './health/health.module';
import { ConfigModule } from './config/config.module';

@Module({
  imports: [
    NestConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'client', 'dist'),
      exclude: ['/api/{*path}'],
    }),
    AuthModule,
    CatalogModule,
    InstalledModule,
    HealthModule,
    ConfigModule,
  ],
})
export class AppModule {}
