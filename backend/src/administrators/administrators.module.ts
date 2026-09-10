import { Module } from '@nestjs/common';
import { AdministratorsController } from './administrators.controller';
import { AdministratorsService } from './administrators.service';
import { AdministratorGuard } from './administrator.guard';
import { OrganizationController } from './organization.controller';
import { AuditController } from '../audit/audit.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [AdministratorsController, OrganizationController, AuditController],
  providers: [AdministratorsService, AdministratorGuard],
  exports: [AdministratorsService, AdministratorGuard],
})
export class AdministratorsModule {}
