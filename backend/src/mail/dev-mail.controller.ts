import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { InMemoryMailTransport } from './in-memory-mail.transport';
import { MailService } from './mail.service';

/**
 * Harness-only surfaces for Seam 2 (captured email), mounted only when the
 * in-memory transport binding is active — never in SMTP mode. The POST exists
 * so the outbound mail boundary is observable end-to-end in the walking
 * skeleton; product flows (verification, reset, invitation) replace it as
 * senders from ticket 03 onward. These are test seams, not product features.
 */
class SendDevMailBody {
  @IsEmail()
  to!: string;

  @IsString()
  @MinLength(1)
  subject!: string;

  @IsString()
  @MinLength(1)
  body!: string;
}

@ApiTags('Development')
@Controller('dev/mail')
export class DevMailController {
  constructor(
    private readonly mail: MailService,
    private readonly transport: InMemoryMailTransport,
  ) {}

  @Get()
  list(): { emails: ReturnType<InMemoryMailTransport['list']> } {
    return { emails: this.transport.list() };
  }

  @Post()
  async send(@Body() payload: SendDevMailBody): Promise<{ sent: true }> {
    await this.mail.send({
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
    });
    return { sent: true };
  }
}
