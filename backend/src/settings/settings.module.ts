import { Module } from '@nestjs/common';
import { AdministratorsModule } from '../administrators/administrators.module';
import { StorageModule } from '../storage/storage.module';
import { OrganizationSettingsController } from './organization-settings.controller';
import { OrganizationSettingsService } from './organization-settings.service';

@Module({
  imports: [StorageModule, AdministratorsModule],
  controllers: [OrganizationSettingsController],
  providers: [OrganizationSettingsService],
  exports: [OrganizationSettingsService],
})
export class SettingsModule {}
