import { Module } from '@nestjs/common';
import { AdministratorsModule } from '../administrators/administrators.module';
import { ConfigModule } from '../config/config.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../mail/mail.module';
import { ThrottleModule } from '../throttle/throttle.module';
import { IdentitiesService } from './identities.service';
import { EndUsersController } from './end-users.controller';
import { IdentitiesController } from './identities.controller';
import { IdentityDirectoryService } from './identity-directory.service';

@Module({
  imports: [
    ConfigModule,
    StorageModule,
    MailModule,
    AdministratorsModule,
    SessionsModule,
    ThrottleModule,
  ],
  controllers: [EndUsersController, IdentitiesController],
  providers: [IdentitiesService, IdentityDirectoryService],
  exports: [IdentitiesService],
})
export class IdentitiesModule {}
