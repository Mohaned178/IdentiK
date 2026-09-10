import { Module } from '@nestjs/common';
import { databaseProvider } from './database.provider';
import { DATABASE } from './token';

@Module({
  providers: [databaseProvider],
  exports: [DATABASE],
})
export class StorageModule {}
