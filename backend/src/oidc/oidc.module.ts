import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { IdentitiesModule } from '../identities/identities.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { ThrottleModule } from '../throttle/throttle.module';
import { AuthorizeController } from './authorize.controller';
import { AuthorizeService } from './authorize.service';
import { ClientAuthenticationService } from './client-authentication.service';
import { DiscoveryController } from './discovery.controller';
import { IssuerService } from './issuer.service';
import { SigningKeysService } from './signing-keys.service';
import { TokenManagementController } from './token-management.controller';
import { TokenController } from './token.controller';
import { TokenService } from './token.service';
import { UserInfoController } from './userinfo.controller';

@Module({
  imports: [
    StorageModule,
    ApplicationsModule,
    IdentitiesModule,
    SessionsModule,
    EnrollmentsModule,
    ThrottleModule,
  ],
  controllers: [
    AuthorizeController,
    TokenController,
    TokenManagementController,
    UserInfoController,
    DiscoveryController,
  ],
  providers: [
    AuthorizeService,
    ClientAuthenticationService,
    IssuerService,
    SigningKeysService,
    TokenService,
  ],
})
export class OidcModule {}
