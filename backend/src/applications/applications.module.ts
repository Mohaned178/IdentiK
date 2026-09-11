import { Module } from '@nestjs/common';
import { AdministratorsModule } from '../administrators/administrators.module';
import { StorageModule } from '../storage/storage.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

@Module({
  imports: [StorageModule, AdministratorsModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
