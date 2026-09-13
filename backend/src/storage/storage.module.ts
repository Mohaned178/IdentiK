import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DATABASE } from './token';

@Module({
  providers: [{ provide: DATABASE, useClass: PrismaService }],
  exports: [DATABASE],
})
export class StorageModule {}
