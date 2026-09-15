import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { instanceConfig } from './config/instance-config';
import { installEdgePosture } from './edge/edge-posture';
import { installGracefulShutdown } from './lifecycle/graceful-shutdown';
import { ShutdownService } from './lifecycle/shutdown.service';

// The release tarball ships backend/package.json next to dist (see the
// release workflow), so this stays in sync without code changes.
const { version: packageVersion } = require('../package.json') as { version: string };

function installApiDocs(app: NestExpressApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('IdentiK')
      .setDescription(
        'Identity provider API: bootstrap ceremony, administrators, identities, ' +
          'applications, OIDC, account center, and audit.',
      )
      .setVersion(packageVersion)
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document);
}

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
  // Interactive API docs are a development surface like /dev/mail: mounted
  // only when IDENTIK_DEV_MODE=1, never in production.
  if (config.devMode) {
    installApiDocs(app);
  }
  const listening = app.listen(config.port);
  // Handlers live before the listener resolves so a signal during boot is drained.
  installGracefulShutdown(app, shutdown, listening);
  await listening;
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
