import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { instanceConfig } from './config/instance-config';

async function bootstrap(): Promise<void> {
  const { port } = instanceConfig();
  const app = await NestFactory.create(AppModule);
  // SIGTERM/SIGINT close the app, which awaits every provider's shutdown hook
  // — notably the data client's disconnect and pool release.
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
