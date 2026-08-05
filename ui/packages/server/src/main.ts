import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';

const CLIENT_DIST = join(__dirname, '..', '..', 'client', 'dist');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:5173'];
  app.enableCors({ origin: allowedOrigins });

  // SPA deep-link fallback. @nestjs/serve-static serves real files (and `/`),
  // but a hard load of a client-only route like /catalog or /apps/:name has no
  // matching file and would otherwise 404 at the server. Serve index.html for
  // any GET that isn't an /api call and doesn't look like a static asset
  // (no file extension), so react-router resolves the route in the browser.
  // Registered after setGlobalPrefix so it never shadows /api/* controllers.
  // NB: use the `{ root }` form — Express 5's res.sendFile(absolutePath) throws
  // a spurious NotFoundError for an existing file; sendFile(name, { root }) is
  // the form that resolves correctly.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api') ||
      req.path.includes('.')
    ) {
      return next();
    }
    res.sendFile('index.html', { root: CLIENT_DIST }, (err) => {
      if (err) next(err);
    });
  });

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
