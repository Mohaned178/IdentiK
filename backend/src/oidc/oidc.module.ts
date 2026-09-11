import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { IdentitiesModule } from '../identities/identities.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { AuthorizeController } from './authorize.controller';
import { AuthorizeService } from './authorize.service';

@Module({
  imports: [
    StorageModule,
    ApplicationsModule,
    IdentitiesModule,
    SessionsModule,
    EnrollmentsModule,
  ],
  controllers: [AuthorizeController],
  providers: [AuthorizeService],
})
export class OidcModule {}
