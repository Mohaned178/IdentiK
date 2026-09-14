import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MailboxProofService } from './mailbox-proof.service';

@Module({
  imports: [StorageModule],
  providers: [MailboxProofService],
  exports: [MailboxProofService],
})
export class MailboxProofModule {}
