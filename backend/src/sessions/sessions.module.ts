import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { EndUserSessionGuard } from './end-user.guard';
import { SessionsService } from './sessions.service';

@Module({
  imports: [StorageModule, SettingsModule],
  providers: [SessionsService, EndUserSessionGuard],
  exports: [SessionsService, EndUserSessionGuard],
})
export class SessionsModule {}
