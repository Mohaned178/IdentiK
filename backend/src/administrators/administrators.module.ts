import { Module } from '@nestjs/common';
import { AdministratorsController } from './administrators.controller';
import { AdministratorsService } from './administrators.service';
import { AdministratorGuard } from './administrator.guard';
import { OwnerGuard } from './owner.guard';
import { InvitationsService } from './invitations.service';
import { OrganizationController } from './organization.controller';
import { AuditController } from '../audit/audit.controller';
import { AuditService } from '../audit/audit.service';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [StorageModule, MailModule],
  controllers: [AdministratorsController, OrganizationController, AuditController],
  providers: [AdministratorsService, AdministratorGuard, OwnerGuard, InvitationsService, AuditService],
  exports: [AdministratorsService, AdministratorGuard, OwnerGuard, AuditService],
})
export class AdministratorsModule {}
