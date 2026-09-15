import { ConflictException, ForbiddenException, Get, HttpCode, Post, Query, Body, Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { BootstrapService, CeremonyRefusedReason } from './bootstrap.service';

class CompleteBootstrapBody {
  @IsString()
  @MinLength(2)
  organizationName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(1)
  name!: string;
}

@ApiTags('Setup')
@Controller('api/setup')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Get('status')
  status() {
    return this.bootstrap.state();
  }

  @Post()
  @HttpCode(201)
  async complete(
    @Query('token') token: string | undefined,
    @Body() body: CompleteBootstrapBody,
  ) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ForbiddenException('setup not available');
    }
    const result = await this.bootstrap.complete(token, body);
    if (result.ok) return result.value;
    if (result.reason === CeremonyRefusedReason.AlreadyCompleted) {
      throw new ConflictException('bootstrap already completed');
    }
    throw new ForbiddenException('setup not available');
  }
}
