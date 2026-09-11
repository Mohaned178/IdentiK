import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { SessionsService } from './sessions.service';

@Module({
  imports: [StorageModule],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
