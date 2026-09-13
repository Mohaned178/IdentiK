import { Module } from '@nestjs/common';
import { ThrottleService } from './throttle.service';

@Module({
  providers: [ThrottleService],
  exports: [ThrottleService],
})
export class ThrottleModule {}
