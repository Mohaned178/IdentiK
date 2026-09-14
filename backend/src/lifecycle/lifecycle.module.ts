import { Global, Module } from '@nestjs/common';
import { ShutdownService } from './shutdown.service';

/**
 * Global like ConfigModule: readiness consumes the shutdown state, and the
 * bootstrap drives the drain.
 */
@Global()
@Module({ providers: [ShutdownService], exports: [ShutdownService] })
export class LifecycleModule {}
