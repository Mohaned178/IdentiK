import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EnrollmentsService } from './enrollments.service';

@Module({
  imports: [StorageModule],
  providers: [EnrollmentsService],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule {}
