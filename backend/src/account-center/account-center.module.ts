import { Module } from '@nestjs/common';
import { IdentitiesModule } from '../identities/identities.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { AccountCenterController } from './account-center.controller';
import { AccountCenterService } from './account-center.service';

@Module({
  imports: [StorageModule, SessionsModule, IdentitiesModule],
  controllers: [AccountCenterController],
  providers: [AccountCenterService],
})
export class AccountCenterModule {}
