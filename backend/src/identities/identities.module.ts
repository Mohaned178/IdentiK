import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../mail/mail.module';
import { IdentitiesService, LinkBaseService } from './identities.service';
import { EndUsersController } from './end-users.controller';

@Module({
  imports: [StorageModule, MailModule],
  controllers: [EndUsersController],
  providers: [IdentitiesService, LinkBaseService],
  exports: [IdentitiesService],
})
export class IdentitiesModule {}
