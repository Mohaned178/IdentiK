import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { instanceConfig } from './config/instance-config';
import { installGracefulShutdown } from './lifecycle/graceful-shutdown';
import { ShutdownService } from './lifecycle/shutdown.service';

async function bootstrap(): Promise<void> {
  const { port } = instanceConfig();
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true });
  const shutdown = app.get(ShutdownService);
  // Registered before the Instance accepts traffic so every request is counted.
  app.use(shutdown.trackRequest);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const listening = app.listen(port);
  // Handlers live before the listener resolves so a signal during boot is drained.
  installGracefulShutdown(app, shutdown, listening);
  await listening;
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
