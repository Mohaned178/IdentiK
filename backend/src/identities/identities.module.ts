import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../mail/mail.module';
import { IdentitiesService } from './identities.service';
import { EndUsersController } from './end-users.controller';

@Module({
  imports: [ConfigModule, StorageModule, MailModule],
  controllers: [EndUsersController],
  providers: [IdentitiesService],
  exports: [IdentitiesService],
})
export class IdentitiesModule {}
