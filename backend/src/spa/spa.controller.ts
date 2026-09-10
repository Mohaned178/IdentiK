import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Serves the dashboard SPA at / with fallback to it for unknown non-API
 * routes (client-side routing). The SPA location is deployment configuration
 * (IDENTIK_SPA_DIST); the default assumes the workspace frontend build sits
 * beside the backend build.
 */
@Controller()
export class SpaController {
  private readonly spaIndex = resolve(
    process.env.IDENTIK_SPA_DIST ??
      join(__dirname, '..', '..', '..', 'frontend', 'dist', 'index.html'),
  );

  @Get(['/', '*'])
  serve(@Req() req: Request, @Res() res: Response): void {
    if (req.path.startsWith('/api/') || req.path.startsWith('/dev/')) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    if (!existsSync(this.spaIndex)) {
      res.status(503).send('dashboard build not found');
      return;
    }
    res.sendFile(this.spaIndex);
  }
}
