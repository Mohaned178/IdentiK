import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { EnrollmentsService } from './enrollments.service';

@Module({
  imports: [StorageModule, SessionsModule],
  providers: [EnrollmentsService],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule {}
