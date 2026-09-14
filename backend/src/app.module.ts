import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { MailModule } from './mail/mail.module';
import { StorageModule } from './storage/storage.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { AdministratorsModule } from './administrators/administrators.module';
import { IdentitiesModule } from './identities/identities.module';
import { ApplicationsModule } from './applications/applications.module';
import { OidcModule } from './oidc/oidc.module';
import { AccountCenterModule } from './account-center/account-center.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    ConfigModule,
    LifecycleModule,
    HealthModule,
    MailModule,
    StorageModule,
    BootstrapModule,
    AdministratorsModule,
    IdentitiesModule,
    ApplicationsModule,
    OidcModule,
    AccountCenterModule,
    SettingsModule,
  ],
})
export class AppModule {}
