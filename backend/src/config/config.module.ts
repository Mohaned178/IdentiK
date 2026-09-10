import { Global, Module } from '@nestjs/common';
import { LinkBaseService } from './link-base.service';

/**
 * Instance-scoped deployment configuration shared by every feature that builds
 * outbound links. Global so feature modules do not have to re-import it.
 */
@Global()
@Module({
  providers: [LinkBaseService],
  exports: [LinkBaseService],
})
export class ConfigModule {}
