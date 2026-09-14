import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { instanceConfig } from './config/instance-config';
import { installEdgePosture } from './edge/edge-posture';
import { installGracefulShutdown } from './lifecycle/graceful-shutdown';
import { ShutdownService } from './lifecycle/shutdown.service';

async function bootstrap(): Promise<void> {
  const config = instanceConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    forceCloseConnections: true,
  });
  // Proxy trust and the browser header posture, before any request is served.
  installEdgePosture(app, config);
  const shutdown = app.get(ShutdownService);
  // Registered before the Instance accepts traffic so every request is counted.
  app.use(shutdown.trackRequest);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const listening = app.listen(config.port);
  // Handlers live before the listener resolves so a signal during boot is drained.
  installGracefulShutdown(app, shutdown, listening);
  await listening;
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
